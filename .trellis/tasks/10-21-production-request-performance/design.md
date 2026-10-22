# 设计：Sentry 驱动的优化方案（待审核，未实施）

状态：待审核；**不授权产品代码变更**。证据：主文档 E18（2026-10-21 Sentry 7d）+ 本轮源码回读。

权威分析总表仍在 `docs/production-request-performance-plan.md`。本文给出各批次**可实施的优化设计**：改什么、不改什么、验收与回滚。

---

## 0. 设计总则

| 原则     | 含义                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| 证据分层 | `SENTRY` 交易级 p95 ≠ 分段根因；长尾先有界等待，再改查询形状                     |
| LLM 分轨 | messages/regenerate 总时长不得冒充代码收益；只验收 prepare / HTTP / 前端请求次数 |
| 最小充分 | 优先现有模块内改法；不建 Redis/队列/全局超时框架/新 ORM                          |
| 契约谨慎 | 默认不改 shared 公开 API；确需内嵌摘要时先审 shared 再动前后端                   |
| 分层超时 | Prisma 池超时 ≠ PostgREST/supabase-js 超时 ≠ undici 300s 默认                    |
| 一次一维 | 连接/超时参数每次只改一个维度；保存旧值于安全运维系统                            |

拒绝的过度设计：按 ids 批量角色通用框架（除非前端 miss 证明必要）、金框物化列、跨请求缓存 chat history、用缩短模型输出换 p95。

---

## 1. 复用调研（本轮源码回读）

| 对象                                              | 路径锚点                                                                                 | 决策                                          | 理由                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `/chats` 历史行                                   | `packages/frontend/src/app/(main)/chats/page.tsx` L113–120 `useCharacterQuery`           | **P1-L-N1 首选：停掉逐行详情**                | 注释已写明「只为头像」；收藏 Tab 已批量                   |
| 大厅 list 缓存                                    | `lib/api/characters.ts` localStorage + `useCharactersQuery`                              | 作头像/名称来源                               | 已有 `CharacterSummary`；勿用 Summary 硬灌 Detail cache   |
| 会话列表契约                                      | `shared` `ChatSession` 仅 `character_id`                                                 | 二期可选内嵌摘要                              | 模式对齐 favorites；非首批必需                            |
| 详情金框                                          | `routes/characters.ts` L165–176：`findFirst` + **全量 `findMany` id** + ranking + pinned | **P1-N-DETAIL：抽 featured 快照，删全量扫描** | 金框须与大厅同源（源码注释）；可用 60s 缓存替代每请求全表 |
| 收藏金框                                          | `routes/favorites.ts` 全量 `findMany` 摘要                                               | 同 featured 快照 + `id in (...)`              | 收藏少时也不应扫全大厅                                    |
| ranking/pinned                                    | `features/lobby/*` 已有 60s TTL                                                          | 扩展为 featuredIds 同 TTL + single-flight     | 复用既有模式                                              |
| 上下文两次 GET                                    | `ConversationHistoryRepository.getContextBeforeTurn` L514–553                            | **P1-S-HTTP：合并 OR 查询**                   | `windowStart>1` 时并行第二次 GET → ST-MINIAPP-2G          |
| supabase client                                   | `lib/supabase.ts` 未设 `db.timeout`                                                      | **P1-C：全局有界 + 热路径 signal**            | 无 abort 可读到 undici ≈300s                              |
| `getOrCreateDbUser` / `fetchRuntimeConfigEntries` | `lib/user.ts` / `runtime-config.ts`                                                      | 补 abort；准备期 deadline 须传到底层          | race 只拒等待不取消 HTTP                                  |
| generation / settle                               | `features/generation/*`                                                                  | 不改计费/CAS 顺序                             | 非本轮提速对象                                            |

---

## 2. 批次优化设计

### 2.1 P0-A — 基线固化与分段观测（设计）

**目标**：把 E18 变成可复跑对照，并补「同请求阶段」缺口。

| 项            | 设计                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ | ------ | -------- | ---------------------------------------------------------------------------------------- |
| Sentry 对照表 | 固定查询：http.server p95 by transaction、pageload p95、Supabase REST >5s count、Issues 1Y/3M/2G |
| 后端阶段日志  | 复用 pino：characters 列表/详情记 `phase=list                                                    | detail | featured | ranking`+ duration；messages 记`prepare_ms`/`context_http_count`/`dispatch_ms`（无正文） |
| 前端          | 可选：大厅/chats 记脱敏请求次数（不落 initData）                                                 |
| 不做          | 新 APM 产品、逐 token 日志                                                                       |

**验收**：改前后同一 `statsPeriod` 可并排；无秘密字段。

---

### 2.2 P0-B — 大厅有界等待（设计）

**目标**：消除用户侧「skeleton 挂死」；**不**把超时当成功提速。

| 层        | 设计                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ |
| 浏览器    | `useCharactersQuery` 的 fetch 尊重 Query `signal`；总预算候选 **15s**（含 1 次安全读重试），审核后落地 |
| Next 代理 | `/api/lobby-characters` 对上游设更短 deadline，body 读取受限                                           |
| UI        | 失败可重试；有旧快照时保留卡片并提示刷新失败                                                           |
| 不做      | 把 abort 当服务器 SQL 已撤销                                                                           |

**与 Sentry**：`GET /api/characters` p50≈100ms、p95≈60s → 有界等待优先保护尾部体验。

---

### 2.3 P0-C / P1-C — 连接与 PostgREST 超时（设计）

**容量表（交付物，先于调参）** 每服务一行：副本×进程、Prisma 池上限、pool_timeout、connect_timeout、supabase-js/`db.timeout`、常见查询 abort、滚动重叠系数。只存数值类别，不存 URL/秘密。

| 改动 | 设计                                                                                   | 风险控制                                              |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C-T1 | `createClient` 增加有界 `db.timeout`（候选与业务读 5–15s 对齐，审核定值）              | 一次只改超时；观察 5xx/业务失败率                     |
| C-T2 | `getOrCreateDbUser`、`fetchRuntimeConfigEntries`、未带 signal 的热路径补 `AbortSignal` | 与 `withConversationPreparationDeadline` 串联真实取消 |
| C-T3 | Prisma URL/启动配置显式 `pool_timeout`/`connect_timeout`（有容量数据后）               | 禁止无限等待；提高 timeout 不是优化                   |
| C-T4 | E10 排序 job：错峰/有界执行；E11 unlock 失败仍 close                                   | TEST 故障注入                                         |
| 不做 | 每请求新建 client；默认扩副本；关闭结算恢复                                            |

**验收指标**：`supabase_rest_gt5s_count`（users / runtime_config / current_chat_history）下降；P2024/P2037 与 unaffected API 成功率同窗报告。

---

### 2.4 P1-L-N1 — `/chats` N+1 API（ST-MINIAPP-1Y）（设计）

**根因（CODE + SENTRY）**：`ConversationHistoryRow` 对每会话调用 `useCharacterQuery(character_id)` → 每唯一角色一次 `GET /api/characters/:id`（默认列表 ≤20）。仅需头像与缺省标题。

```text
现状: conversations list → N × GET /api/characters/:id
目标: conversations list → 0～少数 miss 次详情（或 0，若二期内嵌摘要）
```

#### 方案 A（首批，零契约）— 推荐

1. 从 `useCharactersQuery` / lobby localStorage 摘要按 `character_id` 解析 `avatar_url`、`name`。
2. 标题继续 `resolveSessionTitle(session.title, nameFallback)`。
3. **仅 miss**（下架/未进大厅缓存）时才启用 `useCharacterQuery`，或显示占位头像 + `session.title`。
4. **禁止**把 `CharacterSummary` `setQueryData` 进 `characterKeys.detail`（缺 greeting 等，污染聊天页）。

#### 方案 B（二期，小契约）

在 `ChatSession`（或 list DTO）增加可选 `character: Pick<CharacterSummary,'id'|'name'|'avatar_url'>`，后端 list 一次 join/批量取摘要。对齐 favorites 模式。须 shared 审核。

#### 明确不做

- 新建通用 `characters?ids=` 框架（除非 A 后 miss 率高且不愿动会话契约）。
- 仅靠加大 `staleTime`（冷启动仍 N 次）。

**验收**：ST-MINIAPP-1Y 事件/用户下降；`/chats` 打开时 Network 中 `GET /api/characters/:id` ≈ unique(miss)；列表展示正确；可独立回滚前端。

**依赖**：可与 P1-N-DETAIL 并行；A 不依赖后端。

---

### 2.5 P1-L-TAIL / P1-N-DETAIL — characters 长尾与「N+1 Query」（设计）

**根因修正**：ST-MINIAPP-3M 的 offending `BEGIN` 对应详情 handler **并行多路 Prisma**（含全量 id `findMany`），池紧张时多路 ≈60s 等待；**不是**经典 ORM 按行循环 N+1。

#### 共享组件：`loadLobbyFeaturedIdSet`（新，落在 `features/lobby/`）

| 项   | 设计                                                                                        |
| ---- | ------------------------------------------------------------------------------------------- |
| 输入 | 复用 `loadCharacterRankingScores` + `resolveLobbyPinnedCharacters` + **一次**运营序 id 列表 |
| 输出 | `Set<string>`（或只读快照）                                                                 |
| 缓存 | 与 ranking 对齐：**60s TTL + single-flight**；失败可沿用旧快照（与现有 ranking 降级一致）   |
| 语义 | 必须继续调用 `resolveLobbyFeaturedIds`，保证列表/详情/收藏金框同源                          |

#### P1-N-DETAIL（`GET /api/characters/:id`）

1. `findFirst` **改为 `select` 契约字段**（id/name/description/avatar_url/tags/creator/first_mes/creator_notes…），避免拖 `raw_card` 等大 JSON。
2. 删除每请求全量 `findMany({ select: { id } })`；改为 `featuredIds.has(id)` 来自共享快照。
3. ranking/pinned 已在快照路径内；热缓存后详情常降为 **1 路 Prisma**。

#### P1-L-TAIL（列表 / badge / favorites）

| 接口                               | 设计                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/characters`              | 保持摘要 `select`；recommended 的 ranking 刷新 **single-flight**（主文档 P1-B）；不默认分页                               |
| `GET /api/favorites`               | RPC 得 ids 后 `findMany({ where: { id: { in: ids }, …}})`；金框用共享 featured 快照，**禁止**为金框再拉全大厅             |
| `GET /api/characters/latest-badge` | 查询保持轻量；长尾交给 **用户/settings 的 abort**（P1-C）；评估前端 `staleTime` 避免无意义 stampede（产品可接受陈旧窗后） |

**验收**：

- `character_detail_api_p95_ms`、`lobby_api_p95_ms`、favorites p95 下降；p50 不显著恶化。
- ST-MINIAPP-3M 复发下降。
- 金框：同卡在列表与详情一致性人工抽检。
- 可见性：`enabled` / `archived_at` 过滤不变。

**回滚**：恢复原 handler 查询形状；featured 缓存为进程内，无迁移。

---

### 2.6 P1-S-HTTP — messages Consecutive HTTP（ST-MINIAPP-2G）（设计）

**根因**：`getContextBeforeTurn` 在 `windowStartTurn > 1`（已泄洪）时对 `current_chat_history` **两次 GET**（窗口行 + turn 1 开场白）。未泄洪只有 1 次，不触发该 Issue。

#### 方案（最小）

1. **单次查询**：`turn_index ∈ [windowStart, turnIndex) OR turn_index = 1`（同 session），内存拆分窗口行与 opening history；`windowStart ≤ 1` 行为与今日一致。
2. **复用开轮 RPC 的 `context_window_start_turn`**（若 RPC 已返回）：下传到 `getContextBeforeTurn`，去掉额外 `chat_sessions` 读（顺手减 RTT，非 Consecutive 主修）。
3. 保持现有 **5s** `abortSignal`；不把 history 做跨请求进程缓存。

#### 与 P1-A 的边界

- P1-S-HTTP 只消连续 HTTP / 多余会话读。
- P1-A（规则/设置/模型目录同轮复用）另批；验收只用 `backend_prepare_ms` 与 `context_http_count`，**不用** messages 总 p95。

**验收**：ST-MINIAPP-2G 下降；泄洪会话上 `current_chat_history` HTTP 从 2→1；开场白仍在；计费/取消/CAS 既有测试通过。

---

### 2.7 P1-N / P1-A / P1-B / P1-S（既有主线，Sentry 约束下的设计要点）

| 批次 | 在 Sentry 之后的定位                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------- |
| P1-N | 开屏 240+720ms、创建 freshness；建议 **P1-N-DETAIL / P1-L-N1 有进展后**再改，避免把入口卡顿全推给动画 |
| P1-A | 同轮平台规则/设置/模型只读快照；须与 P1-S-HTTP、C-T2 对齐 signal                                      |
| P1-B | 排名缓存 single-flight；与 featured 快照可同 PR 或紧随，注意陈旧窗运营审核                            |
| P1-S | 仅证明绘制/终态（非 provider）瓶颈后动手                                                              |

---

### 2.8 P2 / P2-X（旁路）

| 项                      | 设计态度                                 |
| ----------------------- | ---------------------------------------- |
| 慢 SQL/索引             | 仅当 A–D 后仍有 EXPLAIN 证据             |
| webhook / miniapp-entry | P2-X：中位数已高，另开任务；不阻塞四主线 |

---

## 3. 推荐实施顺序（设计锁定，实施仍需 G1）

```text
P0-A（对照表/日志字段审）
 → P0-B（有界等待）∥ P0-C（容量表）
 → P1-L-N1（前端，可最先落地）
 → P1-N-DETAIL + featured 快照（后端杠杆最大）
 → P1-L-TAIL（favorites 收窄；列表 single-flight）
 → P1-S-HTTP（合并 history 查询）
 → P1-C（超时/池参数，一次一维）
 → P1-A / P1-B / P1-N / P1-S
 → P2 / P2-X
```

前端 P1-L-N1 与后端 P1-N-DETAIL **无代码依赖，可并行**；合入后应用 E18 同查询验收，避免互相抢功。

---

## 4. 可靠性与失败路径（设计检查表）

- 超时：browser / proxy / Prisma / supabase 分层；abort ≠ 写回滚。
- 重试：仅安全读、总预算内、有限次；400/401/403 不重试。
- 金框降级：featured 缓存失败时允许有界旧快照或 `is_featured=false`，不得错误展示下架卡。
- `/chats` miss：占位头像可接受；不得因 miss 阻塞进入会话。
- 泄洪上下文：合并查询不得丢 turn1 opening；缺 opening 时行为与现 `assembleConversationContext` 一致。
- 计费：不改预留/快照/CAS 顺序；不盲重试生成。

---

## 5. 可验证性（实施前须可执行）

| 批次               | 命令/对照                                                      | 人工                     |
| ------------------ | -------------------------------------------------------------- | ------------------------ |
| P1-L-N1            | frontend typecheck/lint；Sentry 1Y                             | `/chats` Network 计数    |
| P1-N-DETAIL / TAIL | backend typecheck/test；Sentry 3M + p95                        | 金框一致性、详情字段完整 |
| P1-S-HTTP          | `ConversationHistoryRepository` / generate 既有测试；Sentry 2G | 泄洪会话开场白           |
| P1-C               | 配置审 + TEST 小池；Sentry supabase >5s                        | 负载回落无需重启         |
| 跨包               | `pnpm -r typecheck`（若改 shared）                             | —                        |

不在本设计阶段创建新测试文件；实施时按主文档「测试范围审核」决定是否加回归。

---

## 6. 演进与回滚

- 无 migration、无新 DB 对象（本设计范围）。
- featured / ranking 均为进程内缓存：滚动发布自然失效。
- 方案 B（会话内嵌角色摘要）若启动：shared → backend → frontend，可独立回滚契约字段（可选字段向前兼容）。
- 超时参数：运维保存旧值；一次回滚一个维度。

---

## 7. 审核门禁（阻止实施的未决项）

- [ ] G1：产品/技术审核本文与主文档 §1.1/§8
- [ ] 大厅总预算 15s、supabase `db.timeout`、Prisma pool 数值
- [ ] featured 缓存陈旧窗是否与运营金框时效一致
- [ ] P1-L-N1 是否首批只做方案 A，或并行启动方案 B
- [ ] 灰度/停止阈值（主文档候选：p95 恶化 >10% 或错误率 +0.5pp）

未决不阻碍本文作为设计交付；**未勾选不得 `task start` 写产品代码**。

---

## 8. E19 复采修订（2026-10-22，Sentry 7d，production）

本节是对 §2 的**定量修订**，不是新主线。采样口径：org `wangqiao` / project `st-miniapp`（4511818663788624）/ region `https://de.sentry.io` / window `7d` / `sentry.environment:production`。采样率与被丢弃事件未审计，长尾仍可能偏差。

### 8.1 新增的决定性证据

| 编号  | 查询                                                                 | 结果                                                                                                                                                                                                                                                                                                       | 读法                                                                                                                                                  |
| ----- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| E19-1 | `span.description:"prisma:engine:connection"` group by `transaction` | `GET /api/characters/:id`：p50 **33ms** / p95 **10000.24ms** / count **49,470** / sum ≈ **77.4M ms**；`GET /api/characters` p50 3.1ms / p95 10000.28ms / count 6,080；`latest-badge` p50 **0.04ms** / p95 10000.25ms / count 4,206；`characterRoutes - route-handler` **p50 也是 10000.19ms**（149）       | p95 精确落在 **10000ms** 且 p50 极低 = 典型的**池等待超时常数**，不是查询变慢。这是全站耗时占比最大的一项                                             |
| E19-2 | `span.description:"prisma:client:transaction"`                       | p50 159ms / p95 **120,273ms** / max **129,105ms** / count **64**                                                                                                                                                                                                                                           | 7 天 64 次长事务。与 E19-3 同源                                                                                                                       |
| E19-3 | `span.op:db` 按 `sum(span.duration)`                                 | `WITH windowed AS (… experience.chat_history … GROUP BY character_id, user_id)` p50 15ms / p95 **120,021ms** / count 63                                                                                                                                                                                    | 即 `computeRawCardStats` 的 D30 聚合。**单次约 2 分钟**，且整轮包在交互式事务里                                                                       |
| E19-4 | `span.op:http.client` + `supabase.co` group by description           | `chat_history` 195,246 次（p95 177ms / max 5,002ms）；`runtime_config` 119,680 次（p95 151ms / **max 300,667ms**）；`users` 89,537 次（p95 144ms / **max 300,832ms**）；`miniapp_user_settings` 63,597 次（max 120,351ms）；`current_chat_history` 18,844 次（p50 98ms / **p95 1,998ms** / max 300,797ms） | **p50/p95 其实健康**；≈300s 是**无 abort 时 undici 默认上限**被打满的少量样本。E18 把它写成「高」优先级偏重，应降级为「有界等待」问题，而不是吞吐问题 |
| E19-5 | `span.op:http.server` 按 transaction                                 | `/api/characters/:id` p50 74ms / p95 **10,050ms** / count 22,594（最高频）；`support/unread` p50 100 / p95 585（15,089）；`notifications/unread-count` p50 112 / p95 366（13,670）；`conversations/:id` p50 297 / p95 1,912（10,397）；`wallet/free-quota/:characterId` p50 109 / p95 369（7,130）         | 详情接口 p95 = 10s 与 E19-1 的池超时**同一个常数**，可直接归因                                                                                        |
| E19-6 | pageload p75                                                         | `/` **7,448ms**（1,513）、`/create` **7,578ms**、`/chat/:characterId` **5,875ms**、`/profile/recharge` 5,035ms、`/chats` 3,754ms、`/profile` 3,071ms                                                                                                                                                       | 前端首屏独立于后端长尾，需单独预算                                                                                                                    |
| E19-7 | Issues 搜索（N+1 / consecutive http / slow db）                      | **无结果**                                                                                                                                                                                                                                                                                                 | ST-MINIAPP-1Y/3M/2G 在本轮窗口内未复现为活跃 Issue。**不得据此宣称已修复**（可能已 resolve/ignore 或超出窗口）；验收仍以 §8.3 的 span 指标为准        |

### 8.2 根因修订：详情接口的 10s 不是「N+1 Query」，是池等待

源码对照（`packages/backend/src/routes/characters.ts` L165–176）：

```text
GET /api/characters/:id
  └ Promise.all([
      prisma.character.findFirst({ where:{id,…} })            ← 1 条连接
      prisma.character.findMany({ where:{enabled,…}, select:{id} })  ← 1 条连接，全量在架卡
      loadCharacterRankingScores()      ← 60s 命中时 0 连接，miss 时 1 条
      resolveLobbyPinnedCharacters()    ← PostgREST，不占 Prisma 池
    ])
```

- 每次详情请求**同时**申请 2–3 条池连接 → E19-1 中 `count 49,470` ≈ 22,594 次请求 × 约 2.2 条。单请求多路并行本身就是池放大器。
- `prisma.character.findMany({select:{id}})` 的唯一用途是给 `resolveLobbyFeaturedIds` 提供「运营序全量 id」。这份数据**全站共享、一天只随 ranking 变一次**，却被每个详情请求重新拉一遍。
- `favorites.ts` L68–83 是同样的形状（全量 `findMany` 摘要 + ranking + pinned），E19-1 里 favorites 也出现 10s 池超时（188）。
- `latest-badge` 的 `prisma:engine:connection` **p50 仅 0.04ms**：说明它平时是从池里立刻拿到连接的，p95=10s 完全是**被别人挤掉**的受害者，而不是自身慢。这推翻了「latest-badge 自身是慢接口」的读法。

**结论**：`db.ts` 没有显式 `connection_limit` / `pool_timeout`，池实际容量未知；但无论容量多少，「每请求 2–3 路 + 每请求全表扫 id」在 22.6k 次/7d 的量级上必然把池打穿，而 10s 超时常数正是它的指纹。

### 8.3 修订后的实施顺序与量化目标

E18 原顺序把 P1-L-N1（前端）排在 P1-N-DETAIL 之前。E19 的 `sum(span.duration)` 表明**后端详情接口占了压倒性的总时长**，故调整为：

| 序  | 批次                                             | 具体改动（锚点）                                                                                                                                                                                       | 量化目标                                                                                                                                                                        |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **P1-N-DETAIL**（§2.5 不变，优先级提至最高）     | `characters.ts` L169–173 删除全量 `findMany`，改用共享 `loadLobbyFeaturedIdSet`（60s TTL + single-flight）；`findFirst` 收窄 `select` 到契约字段                                                       | `prisma:engine:connection` 在 `/api/characters/:id` 的 **count 从 ≈49.5k 降到 ≈22.6k**（每请求 1 路）；该 transaction 的 `sum(span.duration)` 降一个量级；p95 脱离 10000ms 常数 |
| 2   | **C2′ 聚合移出请求池**（修订 §2.3 C-T4）         | `lobby-ranking-refresh-job.ts` L87–110：整轮 `prisma.$transaction` 改为**专用直连**（复用 `postgres-advisory-lease.ts` 的 `DIRECT_URL` + session advisory lock 模式），聚合与落表走该连接，不占 API 池 | `prisma:client:transaction` p95 **120s → 不再出现在 API 池**；E19-3 的 2 分钟聚合不再与在线请求抢连接                                                                           |
| 3   | **C1′ 池参数显式化**（§2.3 C-T3 前置条件已具备） | `db.ts` 当前完全依赖默认值。先交付容量表，再在 `DATABASE_URL` 显式 `connection_limit` / `pool_timeout` / `connect_timeout`，一次只改一维                                                               | 10000ms 常数消失或迁移到新设定值；P2024 分类计数与在线成功率同窗报告                                                                                                            |
| 4   | **P1-L-TAIL**（favorites）                       | `favorites.ts` L68–83：RPC 得 ids 后 `findMany({ where:{ id:{ in: ids } } })`；金框改用共享快照                                                                                                        | favorites 的 `prisma:engine:connection` count 与 10s 命中数下降                                                                                                                 |
| 5   | **P1-C 有界等待**                                | `supabase.ts` L30–38 未设任何超时 → 加有界 `db.timeout`；`getOrCreateDbUser` / `fetchRuntimeConfigEntries` 补 `AbortSignal`                                                                            | Supabase REST 的 `max(span.duration)` 从 ≈300s 落到设定上限内；**p50/p95 不应恶化**（E19-4 表明它们本来就健康）                                                                 |
| 6   | **P1-L-N1**（前端 `/chats`）                     | 维持 §2.4 方案 A                                                                                                                                                                                       | `/chats` 打开时 `GET /api/characters/:id` 次数 ≈ unique(miss)                                                                                                                   |
| 7   | **轮询端点合并**（新，低风险）                   | `support/unread`(15k) + `notifications/unread-count`(13.7k) + `wallet/free-quota`(7.1k) 合计 ≈36k 次/7d，p50 均 >100ms。先核对前端轮询间隔与 `staleTime`，再评估是否合并为一个汇总端点                 | 请求次数下降；**不得**为此新建通用聚合框架，也不得延长用户可感知的未读延迟                                                                                                      |
| 8   | **前端首屏预算**（§2.7 P1-N）                    | `/` 与 `/create` 的 p75 ≈7.5s                                                                                                                                                                          | 先拆 TTFB / JS / 图片，再定预算；**不与后端收益混算**                                                                                                                           |

### 8.4 E19 对验收口径的约束

- 第 1–4 项的收益必须用 **`prisma:engine:connection` 的 count 与 sum**（而不是端点 p95）验收：p95 可能因为池不再超时而「看起来」从 10s 跳到几百毫秒，这是超时常数消失，不等于查询本身变快。
- 第 5 项**不能**用「Supabase REST p95 下降」验收——E19-4 显示 p95 本就正常；只验 `max` / `>5s count` 与业务失败率。
- `POST .../messages`（p50 17.6s / p95 68s）与 `regenerate` 继续**分轨**：E19 未提供新的分段证据，不纳入本轮收益计算。
- E19-7 的「Issue 无结果」**不作为修复证明**；1Y/3M/2G 的状态需在 Sentry 内单独确认后再决定是否关闭对应批次。

### 8.5 E20 连接串到手后的**结论更正**（2026-10-22，同日追加）

用户提供了生产 `DATABASE_URL` 的非秘密参数（口令已脱敏，不入库）：

```text
host = aws-1-ap-southeast-1.pooler.supabase.com   port = 6543   （Supavisor 事务模式）
pgbouncer=true   connection_limit=10   pool_timeout=10
```

这同时**证实一条**、**推翻一条**我在 §8.1–8.3 写下的结论。

#### 8.5.1 证实：10000ms 常数 = `pool_timeout=10`

`pool_timeout=10`（秒）精确等于 E19-1 观测到的 p95 `10000.2ms`。§8.2「10s 是池等待超时指纹」成立，§8.3 第 3 项「池参数未知」的 GAP **已关闭**：池就是 `connection_limit=10`。

#### 8.5.2 **更正**：这不是「稳态池耗尽」，而是集中在少数时刻的**雪崩**

§8.3 曾按「每请求 2.2 条连接 × 22.6k 请求 ⇒ 必然打穿池」来论证。补采后这个推理**在量级上站不住**，必须更正：

| 新证据                                               | 数据                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `prisma:engine:connection` 总数                      | **49,470**                                                                                                                         |
| 其中 `span.duration:>9000`（即撞上 pool_timeout 的） | **7,395**，占比约 **15%**                                                                                                          |
| 这 7,395 次的时间分布                                | 高度聚集。取样 60 条里大量落在 `2026-10-19T01:20:10Z` 与 `01:20:36Z` 两个**秒级**窗口                                              |
| 按 transaction 分布                                  | `/api/characters/:id` 7,395、`prisma:engine:connection`(嵌套) 1,013、`GET /api/characters` 957、`latest-badge` 481、`favorites` 15 |

即：**85% 的连接获取是正常的**（p50 仅 33ms）。池并没有被日常流量持续打满；它是在**个别时间点被瞬间击穿**，一次就产生数千条 10s 超时。所以 §8.3 把目标写成「count 从 49.5k 降到 22.6k」**口径错了** —— 减少每请求连接数能降低基线占用，但**真正要消灭的是那 7,395 次尖峰**。

#### 8.5.3 雪崩触发源：`$transaction` 的 `maxWait` 与 job 调度不匹配

`lobby-ranking-refresh-job.ts` 的事实（L25–35、L87–110）：

- `REFRESH_INTERVAL_MS = 24h`，`STARTUP_DELAY_MS = 30s` —— 稳态下 7d 最多十几次，**解释不了 7,395 次超时**。
- 但 E19-2 补采的 14 条 >60s 事务时间戳是：`10-15 09:48 / 11:20 / 12:25 / 12:46`、`10-16 03:34 / 03:54 / 07:51`、`10-17 07:51`、`10-19 01:22`、`10-20 03:44 / 03:58 / 08:22`、`10-21 06:05 / 06:59`。**一天多次且不等间隔** ⇒ 这些是**每次部署/重启后 30 秒**那一发，不是 24h 定时那一发。Railway 滚动发布越频繁，它跑得越多。
- 决定性时间对齐：`10-19T01:22:03` 有一条 104.9s 的事务，而 7,395 次池超时里有一大批正落在 `10-19T01:20:10`～`01:20:36`。**聚合事务与池超时雪崩在同一分钟级窗口内**。

机制链条（`connection_limit=10` 让它成立）：

```text
部署 → 30s 后 job 启动 → $transaction 取走 10 条中的 1 条，持有约 2 分钟
     → 同时新副本开始接流，首页/详情涌入
     → 每个详情请求要 2–3 条，9 条可用连接迅速排满
     → 后来者等满 pool_timeout=10s 全部失败 → 一个窗口内数千条 10s span
```

注意 `TRANSACTION_MAX_WAIT_MS = 15s` **大于** `pool_timeout=10s`：Prisma 要等 15 秒才放弃拿连接，但池 10 秒就超时了，`maxWait` 实际上永远不会生效。这是一处**参数互相矛盾**，应一并修正。

#### 8.5.4 `pgbouncer=true` 带来的独立风险（新增，此前完全未评估）

端口 `6543` + `pgbouncer=true` = Supavisor **事务模式**。这有两个此前没写进任何文档的后果：

1. **`connection_limit=10` 不是 Postgres 后端连接数**，而是本进程到 Supavisor 的客户端连接数。真正的 Postgres 后端由 Supavisor 复用。因此「调大 `connection_limit`」与「Postgres `max_connections`」是两层预算。
   **（E21 更正，见 §8.5.6：实测后端余量充足，本条原先写的「预算紧张、不能加大」不成立。）**
2. **事务模式下 session 级状态不保证跨语句保留**。`postgres-advisory-lease.ts` L25–28 的注释已明确认识到这点，所以支付告警走 `DIRECT_URL`。而排序 job 用的 `pg_try_advisory_xact_lock` 是 **xact 级**（随事务自动释放，不依赖 session 保持），在事务模式下是**安全的** —— 这一点 §8.3 第 2 项原本建议「改走 DIRECT_URL」，理由需要改写：改 `DIRECT_URL` 的目的**不是**修正锁语义（现在的锁本来就正确），而是**把 2 分钟的连接占用移出那 10 条共享额度**。

#### 8.5.5 据此修订 §8.3 的实施顺序与验收口径

| 序    | 改动                                                               | 修订后的理由与目标                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **排序 job 移出共享池**（原序 2，**升为第 1**）                    | 它是雪崩的**触发器**，且改动面最小、风险最低。改用 `DIRECT_URL` 专用短连接（复用 `postgres-advisory-lease.ts` 模式），并把 `maxWait` 调整为小于 `pool_timeout`。目标：消灭与聚合事务同窗口的 10s 尖峰 |
| **2** | **P1-N-DETAIL**（原序 1）                                          | 仍要做，但理由更正为**降低雪崩时的放大倍数**（每请求 2–3 条 → 1 条），而非「消除稳态耗尽」。验收改为：**`span.duration:>9000` 的 count 从 7,395 下降**，而不是总 count 从 49.5k 降到 22.6k            |
| **3** | 池参数显式化                                                       | GAP 已关闭，可直接评估。但**先做 1、2 再调参**：若 1、2 已消尖峰，`connection_limit` 可能无需动。调大前必须按 §8.5.4 核算 Supavisor 两层预算                                                          |
| 4–8   | favorites / Supabase 有界等待 / `/chats` N+1 / 轮询合并 / 前端首屏 | 维持 §8.3 不变                                                                                                                                                                                        |

**验收口径更正（覆盖 §8.4 第 1 条）**：主指标为 **`span.description:"prisma:engine:connection" span.duration:>9000` 的 7d count（基线 7,395）**，辅以该条件下的 distinct 时间窗口数。不再使用「总 count 减半」作为目标 —— 总 count 下降只反映每请求连接数变化，不反映雪崩是否消失。

**不做**：不因本节结论就调大 `connection_limit` 或延长 `pool_timeout`。前者需 Supavisor 两层预算，后者只会让用户等更久才失败（§5.3 已有结论，此处重申）。

#### 8.5.6 E21：副本数 = 3，且后端余量实测充足（2026-10-22，Supabase 只读采集）

运维确认 **Railway 约 3 个副本**。补采生产库（只读，未读业务行）：

| 项                                     | 值                                        | 来源                                 |
| -------------------------------------- | ----------------------------------------- | ------------------------------------ |
| `max_connections`                      | **60**                                    | `current_setting('max_connections')` |
| `superuser_reserved_connections`       | 3                                         | 同上                                 |
| 当前 client backend 总数               | **15**（总 backend 23）                   | `pg_stat_activity`                   |
| 其中 PostgREST(`authenticator`)        | 8（全 idle）                              | 按 `application_name` 分组           |
| 其中 `Supavisor`（含 `cs_runtime_v1`） | 3（全 idle，最长 idle ≈ 81,437s ≈ 22.6h） | 同上                                 |
| Postgres 版本 / 区域                   | 17.6.1，`ap-southeast-1`                  | `get_project`                        |

**与后端同区确认**：库在 `ap-southeast-1`，连接串主机也是 `aws-1-ap-southeast-1` —— §2 GAP 里「Railway 区域」对 DB 往返的影响可降级，p50 33ms 也与同区相符。

**本条推翻 §8.5.4 第 1 点的风险判断**：我此前写「调大 `connection_limit` 须严格两层核算、不能简单加大」，隐含假设是后端预算紧张。实测 60 的上限下只用了 15，3 副本 × 10 = **30 的理论客户端上限也在 60 以内**（即便 Supavisor 一对一透传也不会打穿）。所以**加大 `connection_limit` 在后端侧是安全的**。

但结论仍然是**不加大**，理由换成一条更强的：

> 既然稳态 85% 的连接获取 p50 仅 33ms、后端 idle 居多、且超时呈秒级聚集，**瓶颈不在容量而在「一条 2 分钟长事务 + 瞬时扇出」的时间分布**。加大 `connection_limit` 只会让雪崩时更多请求同时压向数据库，把「快速失败」换成「集体变慢」，并不修复触发器。

因此 §8.5.5 的第 3 步「池参数显式化」**降级为观察项**：先做第 1、2 步，复测 `span.duration:>9000` 的 count；只有当尖峰已消除、而稳态 p95 仍偏高时，才考虑调参。

**两点新发现（独立于本任务主线，登记备查）**：

1. **PostgREST 常驻 8 条 idle 连接** —— 这是 Supabase REST（`supabase.ts`）那条线的后端占用。它与 Prisma 的 10 条是**彼此独立**的两份预算，之前的分析把两条线混在一起看过，此处澄清：Supabase REST 的 ≈300s max 与 Prisma 池超时**没有共享连接层**，仍维持 §8.1「无界等待」的定性。
2. **`cs_runtime_v1` 有一条 idle 约 22.6 小时的连接** —— 属已拆出的客服服务，不在本仓库范围，仅记录。另 advisor 报 `auth_db_connections_absolute`（Auth 固定占 10 条），同样与本任务无关但占用同一 60 的总额。

**数据库 advisor 复核**：performance advisor 无 "slow query" 类告警；62 条 `unindexed_foreign_keys` 与一批 `unused_index` 均为 INFO，且不在 `/api/characters/:id` 的读路径上（该路径按主键查），**不作为本次变慢的解释**。

### 8.6 本节未改变的结论

§0 设计总则、§2.4 方案 A/B、§2.6 P1-S-HTTP、§4 可靠性检查表、§6 回滚策略、§7 审核门禁全部沿用。E19 只调整**优先级与量化目标**，不新增主线、不新增数据库对象、不新增 migration。
