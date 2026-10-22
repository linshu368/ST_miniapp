# 执行计划与验证门禁

状态：**步骤 1 实施中**（2026-10-22 起，依据 design.md §8.5 的 E20/E21 修订顺序）。1c 的 image_plaza 图片缓存已实施；步骤 2（P1-N-DETAIL）、步骤 4（favorites）与 P1-L-N1 方案 A 已实施；P1-C（PostgREST 有界等待）与 P1-S-HTTP（上下文单查询）已实施；步骤 7 轮询收敛第一刀（前端去重，不合并端点）已实施。前端首屏仍为文档阶段。

## 步骤 1（进行中）：排序刷新 job 移出 API 共享连接池

**依据**：design.md §8.5.3（雪崩触发器）、§8.5.5（顺序修订）、§8.5.6（容量实测）。

**问题**：`lobby-ranking-refresh-job.ts` 的 `prisma.$transaction` 持有共享池（`connection_limit=10`）中的 1 条连接约 2 分钟，与副本接流叠加后把池打穿，单个窗口产生数千条 10s（= `pool_timeout`）超时。

**选型（已否决一个方案）**：

- ❌ 复用 `postgres-advisory-lease.ts` 的 `pg.Client`：`RankingDbClient` 依赖 Prisma 的 `$queryRaw` **模板字面量**标签语法，换成 `pg` 要把 `ranking-stats.ts` 里全部聚合 SQL 重写为 `$1/$2` 占位符——改动面与回归风险远超收益。
- ✅ **新建一个仅供该 job 使用、指向 `DIRECT_URL` 的独立 `PrismaClient`**（`connection_limit=1`）：`ranking-stats.ts` 的 SQL 与类型**零改动**，只替换传入的客户端；2 分钟占用移出共享额度。

**为何 `DIRECT_URL` 在此安全**：job 用的是 `pg_try_advisory_xact_lock`（xact 级，随事务自动释放），不依赖 session 保持，绕过 pooler 不改变锁语义（§8.5.4 已澄清）。直连额度占用为每副本 1 条，3 副本共 3 条，`max_connections=60` 下余量充足（§8.5.6）。

**附带修正**：`TRANSACTION_MAX_WAIT_MS = 15s` > `pool_timeout = 10s`，导致 `maxWait` 永不生效（§8.5.3）。专用池只有 1 条连接且无竞争者，`maxWait` 下调。

**失败路径要求**：`DIRECT_URL` 缺失/直连失败时，job 必须**跳过本轮并告警**，不得静默回退到共享池（否则等于没改）；每轮结束必须释放连接，不得常驻 idle（§8.5.6 已见 `cs_runtime_v1` idle 22.6h 的反例）。

**验收**：主指标 `span.description:"prisma:engine:connection" span.duration:>9000` 的 7d count，基线 **7,395**；辅以「`prisma:client:transaction` 长事务窗口内不再伴随详情接口 10s 尖峰」。**不**以端点 p95 作为主判据（§8.4）。

### 1b（2026-10-22 追加）：job 被库侧 `statement_timeout` 掐断，刷新已停摆

**证据（生产 `wbtsfzozlmurljvglhpn`，MCP 只读）**：

- `statement_timeout = 120000`，来源是 `/etc/postgresql-custom/platform-defaults.conf`，属于平台默认值。连接角色 `postgres` 在 `pg_db_role_setting` 里没有覆盖，所以 job 实际受 120s 限制。
- E20 的聚合 span p95 正好是 **120.0s**，事务 max 是 129.1s，与被掐断的表现吻合。
- `miniapp_features.character_ranking_scores` 共 547 行，`computed_at` 全部相同，最后一次写入是 **2026-10-20 16:22 +08**。采集时已过去约 47h。按每 24h 一次、每次部署再补一次的节奏，这段时间每一轮都失败并回滚了。
- 代码里的 `TRANSACTION_TIMEOUT_MS = 10min` 实际不会起作用：库侧在 120s 就已取消语句。

**结论**：单靠迁到专用连接不够。它只解决「挤占 API 池」，不解决「job 自身跑不完」。

**修复**：事务第一条语句执行 `SELECT set_config('statement_timeout', '480000', true)`，放在 advisory lock 之前。第三个参数 `true` 等价于 `SET LOCAL`，只作用于本事务，提交或回滚后自动还原。新增 `STATEMENT_TIMEOUT_MS = 8min`，它必须小于 `TRANSACTION_TIMEOUT_MS = 10min`，这样日志里才能看到 Postgres 原始的 `canceling statement due to statement timeout`，而不是 Prisma 的事务超时。

- 不用 `$executeRawUnsafe('SET LOCAL …')`：需要拼接字符串，而且 Prisma 处理非 DML 语句的返回不稳定。`set_config` 返回行集，可以走参数化的 `$queryRaw`。
- 不用连接串 `options=-c statement_timeout=…`：没有验证 Prisma 是否支持这个 URL 参数，而且它会作用于整条连接。
- 不用 `ALTER ROLE postgres SET statement_timeout`：这会影响 Dashboard、迁移等所有 `postgres` 会话。
- 已在生产只读验证 `set_config(...,true)`：事务内 `current_setting('statement_timeout')` 为 `8min`。

**慢的根因（记录在此，本步不修）**：

- `chat_history` 的 heap 是 617 MB，TOAST 22 GB，约 35.2 万行。`last_autovacuum` 和 `last_vacuum` 都是 **null**，`relallvisible / relpages = 52%`，dead tuples 约 4.9 万。
- EXPLAIN 显示两条聚合都走 `idx_chat_history_character_user_created_at` 的 Index Only Scan，总成本约 7 万，正常应在几秒内完成。但可见性映射只覆盖一半，约一半的行要回 heap 做随机读。再加上 `shared_buffers` 只有 256 MB（`work_mem` 3.5 MB，`max_parallel_workers_per_gather` 1），I/O 成了瓶颈。
- D30 的 `COUNT(DISTINCT (session_id, turn_index))` 用到的列不在该索引里，必须回表。
- **建议的人工运维动作**：低峰时由人工在 SQL Editor 执行 `VACUUM (ANALYZE) experience.chat_history;`，不由代码或 MCP 执行。预期可见性映射接近 100%，Index Only Scan 不再大量回表。该操作不阻塞读写，但 I/O 较重。执行后复查 `relallvisible` 和 job 的 `durationMs`。
- 8min 是否足够**尚未实测**。没有在生产跑 `EXPLAIN ANALYZE`，因为它会真实执行几分钟的重查询。以发布后第一轮 `lobby_ranking.completed.durationMs` 为准。

**发布后核对（1b）**：

1. 部署约 30s 后，日志里应出现 `lobby_ranking.completed`，而不是 `lobby_ranking.failed` 或 `skipped_no_direct_url`。
2. `SELECT max(computed_at) FROM miniapp_features.character_ranking_scores;` 的结果应晚于部署时间。
3. 如果仍然 `failed`，且错误是 statement timeout（此时上限已是 8min），先执行上面的 VACUUM，不要继续调大超时。

**回滚**：回退 `lobby-ranking-refresh-job.ts` 即可。`set_config` 是事务级设置，不会残留，也没有 schema 改动。

### 1c（2026-10-22 追加）：image_plaza 图片广场的图片读取缓存

**问题**：广场 feed 每页 20 张图，改前是 20 次串行 `storage.createSignedUrl`，且每次返回的 `?token=` 都不同。

**为什么缓存必须做在「URL 稳定性」上而不是单纯加内存缓存**（Supabase 官方 Smart CDN 文档）：

- Smart CDN 把**完整 URL 含 `token`** 当缓存键。「每次请求都重新签」= 每次都 cache miss，永远回源。
- 「复用同一个签名 URL」= 后续请求走 CDN 与浏览器缓存。
- token 过期与 CDN 缓存时长相互独立：边缘缓存仍会继续命中该 URL，直到缓存时长到期。切断访问要删对象，不能只靠 token 过期。
- 套餐已确认是 `pro` / `tier_payg`，Smart CDN 自动启用，无需额外开关。

**改动**：

- `storage.ts` 新增进程内签名缓存（`Map`，上限 2000 条，提前 5 分钟失效）。缓存键含 `path + expiresIn + transform`，因为 transform 会改变产物，缩略图与原图必须分开。
- 已发布作品图（`image_plaza_works` 分享产生，本就公开）改用 `signSharedWorkImagePath`，TTL 从 15 分钟提到 **24 小时**，让 URL 在用户整个浏览周期内稳定。
- 未公开资产保守处理：studio 产物图、参考图仍走 `signPlazaImagePath` 的 **15 分钟**，避免提前泄露与内存堆积一次性链接。
- `hydrateWorks` 从串行 `await` 改成 `Promise.all`，并把参考图查询抽成 `resolveReferenceImageUrl` 与之并行；feed 命中缓存时不再出网。
- `createSignedUrl` 不支持 `abortSignal`，用 `withTimeout` 赛跑兜 10s，避免上游卡住拖死整页。
- 前端：studio 产物卡与作品详情页补 `loading="lazy"`，与 feed 卡片的既有写法一致。

**为什么不做公开桶**：这样 CDN 命中率最高、也最省签名成本，但 `image-plaza` 桶里混着未公开的生成产物与参考图；改为公开桶会把这些图一并暴露，且路径可枚举。收益小于风险，否决。

**为什么不做批量签名 `createSignedUrls`**：该接口**不支持 `transform`**，而 feed 依赖 720px 变换；换掉会把每张卡片的全尺寸原图推给小程序端，流量反而更大。

**为什么缓存放在进程内而不是 Redis**：目的不是省那一次 HTTP 调用，而是让 URL 稳定。多副本各自缓存不影响 CDN 命中——每个副本产出的 URL 都指向同一对象，只要自身在 TTL 内稳定即可。

**发布后核对（1c）**：

1. 打开广场 feed，同一页**二次进入**时图片应瞬时出现（浏览器缓存命中）。
2. 连续刷新 feed，响应里同一 `artifact` 的 `image_url` 应逐字节相同（缓存生效）；隔 24 小时以上才会变。
3. Supabase Dashboard 的 Storage 出网流量应明显下降。
4. studio 生成的新产物仍是 15 分钟签名，属预期。

**已知边界**：

- 撤销分享/删除作品后，已发出的 24 小时签名 URL 在 token 有效期内仍可访问。这是私链分享固有性质；如需立即切断，应删除 Storage 对象（文档明确 token 过期不等于撤销）。
- 进程重启后缓存清空，只是重新签一次，不影响正确性。

**回滚**：回退 `storage.ts` / `repository.ts` / 两个前端文件即可。无 migration，无持久状态。

## 步骤 2 / 4 / P1-L-N1（2026-10-22 已实施）：详情、收藏、/chats 请求收敛

**依据**：design.md §2.4、§2.5、§8.2、§8.5.5。

**后端：共享金框快照 `features/lobby/featured-snapshot.ts`（新）**

- `loadLobbyFeaturedIdSet(log)`：运营序全量 id + 排序分 + 固定位 → `resolveLobbyFeaturedIds`（与大厅同源）。
- 60s TTL，与 ranking/pinned 对齐；single-flight，过期瞬间的并发请求只查一次。
- 刷新失败：沿用旧快照；无旧快照则返回空集（少显示金框，不让详情失败）。失败结果不缓存。日志 `lobby_featured.snapshot_failed`，带 `{ err, durationMs, hasStale }`。

**`GET /api/characters/:id`（P1-N-DETAIL）**

- 删除每请求全量 `findMany({ select: { id } })`，改用快照。热缓存下每请求 Prisma 连接数从 2–3 条降为 1 条。
- `findFirst` 收窄 `select` 为契约用到的 8 个字段，不再拖 `raw_card` 等大 JSON。
- 可见性过滤 `enabled / archived_at` 不变；响应结构不变。

**`GET /api/favorites`（步骤 4，P1-L-TAIL）**

- 摘要改为 `id in (收藏 ids)` 且保留可见性过滤，不再为了金框把整个大厅摘要拉一遍。
- 金框改用同一快照；收藏时间倒序与竞态兜底（`flatMap` 跳过缺失）不变。

**前端 `/chats`（P1-L-N1 方案 A，零契约）**

- 历史行先从大厅摘要（`useCharactersQuery(DEFAULT_LOBBY_SORT, { skipMountRefetch: true })`，通常命中 localStorage）取头像和名字。
- 只有大厅里查不到的卡（下架）或大厅读取失败时，才启用 `useCharacterQuery`。大厅仍在加载时不发详情，避免冷启动退化回 N 个请求。
- `useCharacterQuery` 增加可选 `{ enabled }`，其他 3 个调用方行为不变。
- 遵守设计约束：不把 `CharacterSummary` 写进 `characterKeys.detail`（缺 greeting，会污染聊天页）。

**不做（本批）**：大厅列表 `/api/characters` 不接快照（它本来就拉全量摘要，现算即可）；方案 B（会话内嵌角色摘要）需改 shared 契约，另批。

**已知边界**：

- 金框最多比大厅列表晚 60s 生效（三份缓存同为 60s，但起点不同）。这与改前 ranking/pinned 已有的陈旧窗同级。
- `/chats` 的头像来自大厅本地快照，运营改头像后最多到用户下次进大厅才更新；`/chats` 只做展示，进入聊天页仍走详情接口。

**验证（已运行）**：backend `tsc --noEmit` 0、vitest 91 文件 / 723 用例全过；frontend `tsc --noEmit` 0、eslint 0；prettier、`git diff --check` 通过。未新建测试文件。

**人工回归**：

1. 同一张卡在大厅、详情 sheet、收藏页的金框一致。
2. 下架一张已收藏/有会话的卡：收藏页不再出现；`/chats` 该行回退到详情请求，404 时显示占位头像和 `session.title`。
3. `/chats` 打开时 Network 中 `GET /api/characters/:id` 数量 ≈ 不在大厅里的角色数（正常为 0）。
4. 清空 localStorage 后进 `/chats`：先发 1 次大厅列表，之后不发详情。

**发布后对照（Sentry，同 E19 窗口）**：`/api/characters/:id` 的 `prisma:engine:connection` count 与 `span.duration:>9000` count 下降；ST-MINIAPP-1Y 事件下降；favorites 的 10s 命中数下降。

**回滚**：回退 `featured-snapshot.ts`、`routes/characters.ts`、`routes/favorites.ts`、`frontend/src/lib/api/characters.ts`、`chats/page.tsx`。无 migration、无契约变更、无持久状态。

## P1-C / P1-S-HTTP（2026-10-22 已实施）：PostgREST 有界等待 + 生成上下文单查询

**证据（生产 `wbtsfzozlmurljvglhpn`，Sentry 30d `http.client` `/rest/v1/*`；MCP 只读 catalog）**：

- 超过 290s 的 span：`users` 99 次、`runtime_config` 8 次，几乎都是 `internal_error`。这说明 PostgREST 挂死后一直等到网关约 300s 才断开。
- 3–100s 区间里，`users` p50 58.5s、`runtime_config` p50 30.5s。而 `current_chat_history` / `chat_history` 的 p50 都正好 ≈5,000ms，说明它们已有的 5s `abortSignal` 起了作用。
- 10–29s 之间仍有合法的慢请求（最长约 29.1s 的 `rpc/list_character_favorites`，状态 ok）。
- `authenticator` 的 `statement_timeout=120s`，`service_role` 没有单独设置。

**改动**：

| 文件                                                 | 改动                                                                                                                                           | 理由                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/supabase.ts`                                    | `createClient` 加 `db.timeout = 30s`                                                                                                           | 全局兜底，只砍挂死。按每次 HTTP 尝试计，和调用方自己的 `abortSignal` 取先到者。30s 高于实测最长的合法请求（29s）                      |
| `lib/user.ts`                                        | 按 `tg_id` 的两处读加 5s `abortSignal`                                                                                                         | 几乎所有已登录接口都先走这里。读失败就抛错返回 5xx，前端可以重试。insert/update 只受 30s 兜底：`tg_id` 唯一，重试时会回读到已提交的行 |
| `platform/runtime-config.ts`                         | `fetchRuntimeConfigEntries` 默认 5s signal（可传入覆盖）                                                                                       | 读失败本来就返回空 Map，由各调用方用缓存或默认值兜底，行为不变，只是更快失败                                                          |
| `ConversationHistoryRepository.getContextBeforeTurn` | 已泄洪时用一条 `or(turn_index.eq.1, and(gte,lt))` 查询代替原来并发的 2 次 GET，在内存里拆出窗口行和开场白；新增可选参数 `knownWindowStartTurn` | 消除 ST-MINIAPP-2G。未泄洪时查询和原来一致                                                                                            |
| `features/conversations/generate.ts`                 | 把开轮 RPC 返回的 `contextWindowStartTurn` 传给上面的新参数                                                                                    | 去掉一次 `chat_sessions` 读。生图路由不传，仍按原方式回读                                                                             |

**`contextWindowStartTurn` 的可信性核对**：生产 catalog 显示，最内层的 `experience.start_chat_history_turn` 和 `start_chat_history_regeneration` 都返回 `context_window_start_turn`。两层包装函数用 `v_started || ...` 透传，所以 `mapStartedTurn` 读到的是同一事务里泄洪之后的窗口起点，与回读 `chat_sessions` 等价。字段缺失时 `readWindowStart` 回落为 1，最坏情况是不截断上下文，不会丢开场白。

**边界**：

- 中止只是客户端放弃等待，不会撤销服务端 SQL。非幂等 RPC（计费、结算）在 30s 兜底后可能出现“客户端报错、服务端已提交”，这时仍靠既有的对账和恢复路径处理。这类 RPC 的 p95 远小于 30s，命中概率很低。
- supabase-js 的 GET 自带最多 3 次重试，只针对网络错误和 520/503，**不包括 abort**。所以 5s signal 下最坏仍是 5s，不会被重试放大。
- 不改 Prisma 池参数，不改 `statement_timeout`。

**人工回归**：

1. 新用户首次打开 miniapp：用户记录正常创建，`miniapp_entered_at` 正确写入。
2. 超过泄洪阈值（`max_context_turns`）的会话发送消息：回复里仍保留开场白语境，后端日志 `current_chat_history` 每轮 1 次 GET。
3. 未泄洪的会话发送、重生成、生图：行为不变。

**发布后对照（Sentry）**：`/rest/v1/users` 和 `runtime_config` 的 `span.duration:>290000` 应降到 0，p50 应 ≤5s；ST-MINIAPP-2G 事件应下降；`chat_sessions` GET 次数应约等于生图次数。

**回滚**：回退以上 5 个文件即可。无 migration、无契约变更、无持久状态。只想撤掉全局兜底时，单独删掉 `db.timeout` 即可。

## 步骤 7 轮询收敛（2026-10-22 已实施，第一刀：只改前端，不合并端点）

**证据（Sentry 7d，`is_transaction:true`）**：

| 端点                                      | count  | p50   | p95   |
| ----------------------------------------- | ------ | ----- | ----- |
| `GET /api/wallet/free-quota/:characterId` | 69,292 | 30ms  | 271ms |
| `GET /api/support/unread`                 | 14,991 | 101ms | 587ms |
| `GET /api/notifications/unread-count`     | 13,568 | 112ms | 375ms |

**源码核对（`@tanstack/query-core` 5.99.2）**：

- 两个未读 hook 各有 2 个读者：`BottomNav`（`(main)/layout.tsx` 常驻；在隐藏路由上只是 `return null`，hooks 仍在运行）和 `/profile` 页。
- 每个 observer 都有自己的 `setInterval`（`queryObserver.#updateRefetchInterval`），同一个 key 不会合并。停在 `/profile` 时，两个 interval 相位不同，所以每个端点每 20s 发 2 次。
- `useRefetchOnForeground` 调的是 `refetch()`，默认 `cancelRefetch: true`（`query.fetch`：有数据时先 cancel 再重发）。`apiClient` 不接 `signal`，被取消的 HTTP 仍会发出。所以每次切回前台，每个端点会发 N 次（N = 读者数）。

**改动**：

| 文件                                              | 改动                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `lib/api/use-refetch-on-foreground.ts`            | 改为 `refetch({ cancelRefetch: false })`，后到的调用复用进行中的请求；增加可选 `enabled`      |
| `lib/api/notifications.ts` / `lib/api/support.ts` | 未读 hook 增加 `{ poll?: boolean }`，默认 `true`；`false` 时不起 interval，也不注册回前台刷新 |
| `app/(main)/profile/page.tsx`                     | 两个未读读者传 `{ poll: false }`，由 `BottomNav` 统一轮询                                     |

**为什么不合并为汇总端点**：每次请求的成本主要在鉴权和用户解析（p50 ≈100ms），合并能省一半请求，但需要新的 shared 契约，还要在后端同时调用 cs 服务和 DB，两者的失败域会耦合（客服服务慢会拖住公告红点）。本刀只去掉前端的重复请求，红点延迟不变，零契约。是否合并以发布后的 count 为准再定。

**free-quota 本批不改**：它是 count 最高的端点，但 p50 只有 30ms，来源是聊天页挂载、每轮结束后 `refreshQuotaAndBalance` 的最多 3 次重读（0/300/900ms）以及取消后的 invalidate。减少它会影响「免费轮次用尽」提示的准确性，另行评估。

**边界**：

- `/profile` 的红点仍在进页时刷新一次（`refetchOnMount: 'always'` 保留），之后依赖 `BottomNav` 的 interval。`/profile` 不在 `HIDDEN_PREFIXES` 中，二者始终同屏。
- `/profile/messages` 的列表 `useNotificationsQuery` 不变（只有它一个读者）。
- `useLobbyLatestBadgeQuery` 只有一个读者，只受益于 `cancelRefetch: false`，行为不变。

**验证（已运行）**：frontend `tsc --noEmit` 退出码 0；改动文件 eslint 退出码 0；vitest 41 个文件全过；prettier `--check` 退出码 0（先 `--write` 修了 2 个文件的格式）；`git diff --check` 退出码 0。未新建测试文件。

**人工回归**：

1. 停在 `/profile` 60s：Network 中每个未读端点约 3 次（改前约 6 次）。
2. 切到后台再切回：每个未读端点各 1 次。
3. 后台推送一条客服回复或公告：`/profile` 入口红点与底部导航红点同时亮起，延迟 ≤20s。
4. 在 `/profile/support` 读完回复后返回 `/profile`：红点消失（mutation 直接写缓存，不依赖轮询）。

**发布后对照（Sentry，同窗口 7d）**：`/api/support/unread` 与 `/api/notifications/unread-count` 的 count 下降；p50 不变。

**回滚**：回退上述 4 个前端文件。无契约、无后端改动。

---

以下为原文档阶段记录（2026-10-21 Sentry 采样重排）。

主文档：`docs/production-request-performance-plan.md`（E18 = Sentry 证据）。

## 本轮交付

1. 只读规范/源码/依赖/版本/历史记录，标明证据等级。
2. 写规划及主文档，记录拓扑文档与源码差异，不擅改生产事实。
3. **纳入 Sentry MCP 生产 traces/issues 归纳**，映射到 L/N/S/C 与批次表。
4. 验证引用、无占位/秘密、JSON、Prettier、diff 和产品文件未改。
5. 保持 planning 等待审核，不运行 task start、commit 或 push。

本轮仅 Markdown/任务元数据，无受影响应用包；不新增测试、不启动服务/模型。应用 typecheck/test/build 本轮不运行，也不声称通过。后续代码实施必须运行适用检查。

## 设计交付（本轮，仍不实施）

详细优化设计见同目录 `design.md`（2026-10-21 源码回读锁定）。主文档 §9 为入口摘要。

设计已锁定的首选改法：

- P1-L-N1 → 大厅摘要补头像（方案 A）；会话内嵌摘要为方案 B
- P1-N-DETAIL → `loadLobbyFeaturedIdSet` 60s 快照 + 详情收窄 select
- P1-L-TAIL → favorites `id in`；列表 single-flight；badge 依赖 P1-C abort
- P1-S-HTTP → `getContextBeforeTurn` 单次 OR 查询
- P1-C → supabase `db.timeout` + 热路径 signal；Prisma 池另维

## 后续顺序（需批准；与 design.md §3 一致）

1. **P0-A** 固化 E18 对照 + 分段日志字段审核
2. **P0-B**∥**P0-C** 有界等待 + 容量表（含 PostgREST）
3. **P1-L-N1** 前端（可最先合入）
4. **P1-N-DETAIL** + featured 快照（后端最大杠杆）
5. **P1-L-TAIL** favorites 收窄 / 列表 single-flight
6. **P1-S-HTTP** 合并 history 查询
7. **P1-C** 超时/池参数（一次一维）
8. **P1-A / P1-B / P1-N / P1-S**
9. **P2 / P2-X**

每批：TEST 故障注入 → consumers → Preview/Telegram → 批准生产灰度；**改后用同一 Sentry 查询窗口对照 E18**；分别验收四主线，不把改快动画当作接口提速，不把 LLM 变短写成产品收益。`design.md` §7 门禁未勾选不得开始写产品代码。

## 测试范围审核

不在本轮创建测试文件。后续优先扩展现有测试；取消、额度、快照、advisory lease 清理属高风险，审核回归方案后实现，不能只测 happy path。

重点既有测试：

- `packages/frontend/src/lib/api/conversation-stream.test.ts`
- `packages/backend/src/features/conversations/generate.lifecycle.test.ts`
- `packages/backend/src/features/generation/execute.test.ts`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.cancel.test.ts`
- `packages/backend/src/lib/postgres-advisory-lease.test.ts`

Sentry 驱动批次建议追加的人工/回归焦点（实施时再审是否落测试文件）：

- P1-L-N1：`/chats` 打开时 characters HTTP 次数上限与缓存命中。
- P1-L-TAIL / P1-N-DETAIL：列表/详情失败与超时出口；可见性不变。
- P1-S-HTTP：单轮 messages 对 `current_chat_history` 调用次数；计费/取消不变。

## 后续代码验证命令

integration 脚本须另行确认 TEST 目标及写入授权，不随下列本地验证自动执行：

```text
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
pnpm -r --if-present build
pnpm lint:legacy
git diff --check
```

跨包/部署变更跑全消费者 typecheck 和适用 build；契约变更先 shared 测试。记录退出码与失败项，不把既有失败算通过。

生产对照（只读）：复跑 E18 同查询（http.server p95、pageload p95、Supabase >5s、三 Issue 事件量）。

## 人工与失败路径

- 大厅冷/热缓存、推荐/最新、返回定位、过期卡、空列表、离页/断网、headers/body 挂起、重试；**p50 正常但偶发 60s**。
- `/chats` N+1：列表项多时请求风暴、缓存命中后应收敛。
- 入口详情冷/热与预取未命中、新建/继续历史、POST 回填后请求次数、快速连点/离页、创建结果未知、非本人/已删会话、ready 后动画与 reduced motion、多端生成/streaming 恢复。
- AI 权限失败、同轮版本与读次数、预留不足/结果未知、取消/完成竞态、无正文/断流/缺 done、无重复扣款/额度泄漏；**区分 prepare vs provider vs consecutive history HTTP**。
- AI 首字后慢流、delta 已到但绘制慢、末正文后终态慢；相同模型与输入输出规模下记录正文完整性、流中停顿和终态时长。
- TEST 小池饱和、长事务、两副本 job、聚合失败/空结果、锁未获取、unlock 失败仍 close；区分停止等待与底层停止执行；**PostgREST 超时打满**。
- 连接建立半失败、work/cleanup 回调抛错、滚动发布重叠；同步检查其他 API 成功率与 p95，撤去负载后无需重启恢复；重试/排队不得持续放大。
- 真实模型/Telegram 批准后使用专用账户，明确环境和费用，不导出消息正文。

## 停止与回滚

权限/计费/取消异常立即停止。主文档候选性能阈值经审核后使用，结合失败率/样本量。回滚当前小批次代码或安全系统内旧参数；不关闭结算恢复，不回写账务，不把停止 timer 当终止在途事务。必要的新 migration 另审，附恢复方案。
