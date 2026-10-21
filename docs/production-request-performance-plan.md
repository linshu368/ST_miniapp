# 大厅首载、进入会话、消息回复与 Prisma 连接治理规划

> 2026-10-21；源码基线 `bf1d2893`；状态：待审核规划，未实施。
> 本轮仅形成文档，不修改业务代码、生产配置、数据库或依赖。源码风险不等于生产事故证据。
> **2026-10-21 补充**：已用 Sentry MCP（org `wangqiao` / project `st-miniapp`，region `de`，production，近 7 天 traces）补齐生产延迟样本；采样与配额仍可能低估长尾，不能单独替代分段观测与连接容量表。

## 1. 范围与优先结论

按最新生产反馈收敛为 **三个用户体验入口 + 一个共用资源问题**。以下是反馈范围，不代表已经证明四者同根因：

| 主线       | 用户反馈                                 | 主要改动设计                                                                     | 完成判定                                                         |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| L 大厅首载 | 第一次打开大厅，列表出来慢               | 缩短列表关键路径、排序快照刷新合并、有限等待及失败出口；资源传输慢则另做定点优化 | 无本地缓存首屏确实更快；不能用热缓存结果冒充首载收益             |
| N 进入会话 | 点击列表进入会话卡顿                     | 单列详情/导航/建会话/历史加载/开屏退场阶段；复用既有缓存和预取，消除不必要阻塞   | 新会话与继续历史会话分别验证点击到可见、可输入时间               |
| S 消息回复 | 用户发送后回复慢                         | 请求内读取复用，拆开首正文、流式停顿和终态收敛；只优化被定位的瓶颈               | 浏览器首正文更快，流中和终态不退化，计费/取消正确                |
| C 连接治理 | 反馈 Prisma 连接容易满，影响其他请求连接 | 全服务连接预算、后台任务竞争治理、异常释放、有限等待与过载恢复                   | 并发/发布重叠/任务运行时其他请求仍有受控服务能力，负载回落能恢复 |

连接治理是此次**核心交付项，不再等到 P2 才处理**；连接满发生于 Prisma 本地池、Supavisor 还是 Postgres，仍需同窗口证据确认。

### 1.1 Sentry 生产归纳（近 7 天，2026-10-21 采样）

证据标签：`SENTRY`（见 §2 / E18）。单位毫秒原值已换算为秒便于阅读。

| 优先级 | 现象（Sentry）                                                                                                      | 映射主线 | 规划处理批次                         | 说明                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **高** | `GET /api/characters` p95≈60s，p50≈106ms；首页 `/` pageload p95≈12.6s                                                | L        | P0-B → P1-B → **P1-L-TAIL**          | 典型长尾/偶发超时，不是中位数慢；先有界等待，再查排序回源与下游卡住                                               |
| **高** | `/chats` **N+1 API Call**（[ST-MINIAPP-1Y](https://wangqiao.sentry.io/issues/ST-MINIAPP-1Y)）→ `/api/characters/*`    | L / N    | **P1-L-N1**                          | 125 用户；会话列表页对角色详情批量打点，直接拖慢进入与列表可交互                                                  |
| **高** | `GET /api/characters/:id` 7d≈21.5k 次，p95≈10s，p50≈80ms；**N+1 Query**（[ST-MINIAPP-3M](https://wangqiao.sentry.io/issues/ST-MINIAPP-3M)） | N        | **P1-N-DETAIL**                      | 最高频 API；长尾与 DB N+1 并存                                                                                    |
| **高** | `GET /api/characters/latest-badge` p95≈13s（~4.6k 次）                                                              | L        | **P1-L-TAIL**                        | 旁路鉴权读；证明竞争后再延后/合并，不可凭空写成列表串行依赖                                                       |
| **高** | Supabase REST >5s：`users` 817 次、`current_chat_history` 190 次、`runtime_config` 125 次；大量卡在 ≈300s            | C / S    | P0-C → **P1-C** / **P1-S-HTTP**      | 高度像客户端/代理超时上限；Prisma 池调参不能直接消掉 PostgREST 超时                                               |
| **高** | `GET /api/favorites` p95≈60s（次数少）；`POST /api/growth/miniapp-entry`、`POST /api/telegram/webhook` p95≈60s       | L / 旁路 | **P1-L-TAIL**；webhook/entry → **P2-X** | favorites 进大厅旁路长尾；webhook/entry 中位数也高，不进四主线首批，另列                                           |
| **中** | `POST .../messages` Consecutive HTTP（[ST-MINIAPP-2G](https://wangqiao.sentry.io/issues/ST-MINIAPP-2G)）→ `current_chat_history` | S        | **P1-S-HTTP** → P1-A                 | 与 LLM 生成耗时分开：先消连续 HTTP，再谈准备期只读复用                                                            |
| **中** | `/chat/:characterId` pageload p95≈7s；`/chats` ≈3.9s                                                                | N / L    | P1-N + P1-L-N1                       | 前端加载与后端长尾叠加                                                                                            |
| **低*** | `POST .../messages` p95≈66s / p50≈17.5s；`.../regenerate` p95≈93s                                                    | S        | P1-A / P1-S（有分段证据后）          | **\*LLM 生成耗时属业务特性**；不把供应商推理时间算进「可删代码路径」收益，除非产品硬 SLA                          |

实施优先级（在原 P0/P1/P2 上叠加 Sentry 排序）：

1. **P0 定位与止损**：把 Sentry 结论固化为基线快照（E18）；补四主线分段观测与连接容量表；大厅有界等待（防 60s 挂死）。
2. **P1 核心提速（Sentry 驱动）**：先消 `/chats` N+1（P1-L-N1）与 characters 长尾/超时（P1-L-TAIL、P1-N-DETAIL）；并行处理 messages 连续 HTTP（P1-S-HTTP）与 PostgREST/连接预算（P1-C）；再做准备期只读复用与开屏退场。
3. **P2 证据驱动深度调优**：慢 SQL/索引、webhook/growth 中位数偏高、部署拓扑或容量；不默认扩大池、拆服务或换 ORM。

非目标：大面积重构、统一全部数据库访问到 Prisma、取消 Next 代理、迁移供应商、全局 Redis/队列、升级 Prisma、重做 UI、修改计费政策、新建数据库对象；**不以缩短模型输出或换便宜模型冒充回复变快**。

## 2. 证据口径及缺口

| 标签    | 含义                                 | 当前结论                                                                                                                      |
| ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| CODE    | 本地源码已读，未证明现网同版本       | 四主线调用链、现有超时/缓存、后台事务见下文                                                                                   |
| LOCAL   | 前轮本地命令记录，本次未重跑版本命令 | 前轮记录 Prisma/client 6.19.3、Node 24.15.0、pnpm 9.15.9；本次 package.json 确认 Prisma/client 声明为 ^6.19.3，不代表生产版本 |
| DOC     | 历史文档，不替代现网实况             | 10-12 支付告警任务记录过 P2024；当前 helper 已采用专用 pg client，部署情况待核对                                              |
| HISTORY | 前轮对话记录，非本轮重新采样         | Supabase 项目位于新加坡且 ACTIVE_HEALTHY；不能证明查询/连接正常                                                               |
| SENTRY  | 生产 traces/issues 聚合（近 7 天）   | 已采样 http.server / pageload / http.client(Supabase) 与性能 Issue；见 §1.1 / E18。采样率与丢弃事件未单独审计，长尾可能偏差 |
| GAP     | 未取得数据                           | Railway 实际区域、副本/进程数、资源曲线、连接参数、变慢起点、**分段**请求瀑布（Sentry 有交易级 p95，缺同请求阶段拆解）       |

历史 `/health` 本机小样本：经显式代理首次约 2.36s，连接复用约 0.48s，绕过显式代理单次约 1.02s。该端点不查数据库、不调用模型；样本少、网络条件不同，不是业务基线或应用耗时。`x-railway-edge: lax1` 不能用来判断应用部署区域。此前 Railway CLI 返回 `Project not found`，不尝试以仓库 IaC 推断实际拓扑。

**文档/源码差异**：E13 的运维文档描述前端与后端之间“没有任何反代”；E2 明确存在大厅专用 Route Handler。因此大厅按 E2 追踪；普通 API/SSE 按构建配置及浏览器真实目标追踪。此次记录差异，不把未部署方案写成架构现状。

### 证据索引（路径均为本工作区绝对路径）

| ID  | 文件与定位                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/characters.ts`：fetchCharacters、useCharactersQuery；`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/query-client.ts`：retry                                                                                                                                                                              |
| E2  | `d:/codeReposity/wq/ST_miniapp/packages/frontend/src/app/api/lobby-characters/route.ts`：GET；`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/client.ts`：API_URL、apiClient                                                                                                                                                                                           |
| E3  | `d:/codeReposity/wq/ST_miniapp/packages/frontend/src/components/characters/character-gallery.tsx`：CharacterGallery、isLoading/isError；`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/conversation-stream.ts`：SSE deadline                                                                                                                                          |
| E4  | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/routes/characters.ts`：GET /api/characters、latest-badge；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/lobby/ranking-stats.ts`：loadCharacterRankingScores                                                                                                                                                      |
| E5  | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/routes/conversations.ts`：会话入口；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/conversations/generate.ts`：runConversationTurn、withConversationPreparationDeadline                                                                                                                                           |
| E6  | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/generation/execute.ts`：execute；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/generation/settle.ts`：结算边界                                                                                                                                                                                          |
| E7  | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/platform/runtime-config.ts`：fetchRuntimeConfigEntry/Entries；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/platform/model-tiers.ts`：ensureModelConfig；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/features/engine/platform-instructions.ts`：fetchPlatformInstructions                                         |
| E8  | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/infrastructure/repositories/MiniappUserSettingsRepository.ts`：getOrCreate、getGenerationConfig、getDisplayName、refreshTelegramProfile；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/lib/user.ts`：getOrCreateDbUser                                                                                                    |
| E9  | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/lib/db.ts`：Prisma 单例；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/lib/supabase.ts`：HTTP client；`d:/codeReposity/wq/ST_miniapp/packages/backend/prisma/schema.prisma`：generator/datasource；`d:/codeReposity/wq/ST_miniapp/packages/backend/package.json`                                                          |
| E10 | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/lib/lobby-ranking-refresh-job.ts`：runLobbyRankingRefresh；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/app.ts`：任务启动/停止；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/platform/config.ts`：任务开关                                                                                                        |
| E11 | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/lib/postgres-advisory-lease.ts`；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/scripts/payment-alert-monitor.ts`；`d:/codeReposity/wq/ST_miniapp/.trellis/tasks/10-12-fix-payment-alert-worker-lease/task.md`                                                                                                             |
| E12 | `d:/codeReposity/wq/ST_miniapp/packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts`：开轮 RPC、CAS、abortSignal；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.ts`；`d:/codeReposity/wq/ST_miniapp/packages/backend/src/infrastructure/repositories/VeniceChatHistoryRepository.ts` |
| E13 | `d:/codeReposity/wq/ST_miniapp/ops/railway/README.md`；`d:/codeReposity/wq/ST_miniapp/docs/ARCHITECTURE.md`                                                                                                                                                                                                                                                                         |
| E18 | Sentry `wangqiao/st-miniapp`（region `https://de.sentry.io`）：[http.server p95](https://wangqiao.sentry.io/explore/traces/?query=is_transaction%3Atrue+span.op%3Ahttp.server+sentry.environment%3Aproduction&project=4511818663788624&aggregateField=%7B%22groupBy%22%3A%22transaction%22%7D&aggregateField=%7B%22yAxes%22%3A%5B%22p95%28span.duration%29%22%5D%7D&mode=aggregate&sort=-p95%28span.duration%29&statsPeriod=7d&table=span)、[pageload/navigation p95](https://wangqiao.sentry.io/explore/traces/?query=is_transaction%3Atrue+span.op%3A%5Bpageload%2Cnavigation%5D&project=4511818663788624&aggregateField=%7B%22groupBy%22%3A%22transaction%22%7D&aggregateField=%7B%22yAxes%22%3A%5B%22p95%28span.duration%29%22%5D%7D&mode=aggregate&sort=-p95%28span.duration%29&statsPeriod=7d&table=span)、[Supabase REST >5s](https://wangqiao.sentry.io/explore/traces/?query=span.op%3Ahttp.client+span.description%3A*supabase*rest*+span.duration%3A%3E5s&project=4511818663788624&aggregateField=%7B%22groupBy%22%3A%22span.description%22%7D&aggregateField=%7B%22yAxes%22%3A%5B%22p95%28span.duration%29%22%2C%22count%28%29%22%5D%7D&mode=aggregate&sort=-count%28%29&statsPeriod=7d&table=span)；Issues [ST-MINIAPP-1Y](https://wangqiao.sentry.io/issues/ST-MINIAPP-1Y)、[ST-MINIAPP-3M](https://wangqiao.sentry.io/issues/ST-MINIAPP-3M)、[ST-MINIAPP-2G](https://wangqiao.sentry.io/issues/ST-MINIAPP-2G)。采样日 2026-10-21，窗口 7d，environment=production |

## 3. 大厅链路与优化对比

```text
CharacterGallery → useCharactersQuery → 浏览器 /api/lobby-characters
→ Vercel Next Route Handler → Railway /api/characters
→ Prisma 角色列表 → 推荐分支并行读取排序快照与置顶配置 → 排序/响应
→ Next 完整读取响应正文 → 浏览器解析 → 卡片可用 → 图片加载
```

主列表路由未配置 Telegram preHandler，不能把身份查询算入其直接耗时。latest-badge/latest-seen 是另外的鉴权请求，会读取用户并访问数据库；需要测量并发竞争，但不应凭空画成列表的串行前置依赖。

| 项目     | 当前 CODE                                                                      | 拟优化后（待批准）                                                                         | 风险/约束                                                |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 等待边界 | E1/E2 两层 fetch 没有显式业务 timeout；queryFn 未传 Query signal；全局 retry=1 | Query signal 到实际 fetch；代理到上游设置 deadline，读完整 body 也受限；总预算不随重试重置 | abort 不代表服务器 SQL/写入已撤销                        |
| 缓存     | 本地快照最长 24h，staleTime=0、通常挂载刷新；返回定位恢复可跳过挂载刷新        | 保留恢复流程；按实测消除重复刷新，对同 key 合并在途请求                                    | React Query 已按 key 去重，先证明额外重复来自哪里        |
| 代理缓存 | force-dynamic/revalidate=0/no-store；后端 latest 的 60s 缓存头被代理覆盖       | 第一阶段不改入口；优先缓存底层稳定数据，而非最终推荐顺序                                   | 推荐每请求随机冷启动卡，不可整页缓存钉死随机化           |
| 排序读取 | 分数已有 60s 进程缓存；冷启动/过期未见 in-flight 合并；失败可沿用旧快照        | 在现有函数内合并刷新，失败退避；约定最大陈旧期与恢复                                       | 不以空分数模拟全部零样本；运营固定位和门槛随快照保持一致 |
| 失败 UI  | 有 skeleton/error/empty；isError 分支优先于列表展示，没有就地重试按钮          | 初次失败可明确重试；有旧数据时保留卡片并提示刷新失败                                       | 旧卡不绕过详情/开会话可见性检查；过期/下架不得长期可用   |
| 图片     | 已有首屏预加载/连接预热                                                        | 独立测图片解码/LCP；只有图片占主要耗时时才优化资源                                         | API 完成不等于首屏图片完成，不先重写图库                 |

### 3.1 首次加载的专项设计（L）

首次加载必须在无 localStorage 快照、无 React Query 数据条件下测量；同时分离浏览器冷连接和后端缓存冷/热状态。记录代理耗时、后端列表/排序读取耗时、响应大小、JSON 解析与卡片提交、首屏图片完成。已有首屏 8 张图片预加载不能当作本次新增方案。

优先改 E1–E4 的有界请求、排序刷新 single-flight（同进程同一次刷新共用 Promise，finally 清理，失败不永久缓存拒绝）及失败展示；这些分别解决失控等待、并发回源和可恢复性，**超时更早不等于首载成功更快**。若全量列表传输/渲染才是瓶颈，先评估响应中非必要字段；分页会影响搜索、推荐随机化和返回定位，须另审 shared 契约与消费者，不在首批直接改成分页或虚拟列表。latest-badge 等旁路请求只在证明竞争明显时延后，不把它写成列表的串行依赖。

**Sentry 对 L 的约束（E18）**：`GET /api/characters` 中位数正常、p95≈60s，说明首批收益来自「消除偶发挂死/下游超时」多于「把常态 100ms 再砍一半」。`/chats` 的 N+1（ST-MINIAPP-1Y）是独立前端批请求问题，应与大厅列表 API 长尾分轨验收。favorites / latest-badge 的 60s/13s 长尾列入 P1-L-TAIL 同窗排查（用户查询、Prisma、PostgREST `users` 超时是否同因）。

### 3.2 点击列表进入会话：新增独立主线（N）

新增证据定位（均为本次回读的源码，不代表已部署）：

- E14：`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/components/characters/character-detail-sheet.tsx`、`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/chat-entry.ts`：详情读取与导航目标。
- E15：`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/hooks/use-chat-session.ts`、`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/conversations.ts`：创建、缓存回填、详情查询、ready 和重试。
- E16：`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/app/chat/[characterId]/page.tsx`、`d:/codeReposity/wq/ST_miniapp/packages/frontend/src/components/chat/chat-splash.tsx`：页面旁路查询、输入禁用条件、开屏退场。
- E17：`d:/codeReposity/wq/ST_miniapp/packages/backend/src/infrastructure/repositories/ChatSessionRepository.ts`：角色读取、空会话查找/复用与插入；创建 route 见 E5。

```text
点击大厅卡片 → 详情 Sheet（角色详情 query；并预取聊天路由）
→ 用户确认进入 → 返回位置快照 + router.push → 聊天页挂载
  无 session：POST 建会话 → 鉴权/用户 → 并行[建会话、显示名]
    建会话：读取角色 → 查已有空会话 → 无则插入 → 返回 session + 虚拟开场白
    → React Query 写详情缓存 → ready（并检查是否立即发起详情回源）
  有 session：GET 会话详情/消息 → 服务端 ownership/恢复 → ready
→ 开屏退场 → 消息可见/输入可用
```

详情阅读停留时间不能记成系统卡顿：分别计 `card_click→sheet_ready` 和 `enter_click→chat_usable`。普通会话 API 使用配置的 API 地址，不经过大厅专用代理。

| 当前 CODE / 风险                                                                                     | 主要优化设计                                                                                                           | 保留边界与验证                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| E3 已在 preview 时 router.prefetch；Sheet、聊天页、Splash 共用角色详情 query key，默认 30s freshness | 复用已有缓存/路由预取，测缓存命中与路由资源下载；不全列表预建会话或全量预取历史                                        | 未点击进入不得产生创建写入；不能把同 key 多订阅误判为多次实际 HTTP                                                            |
| POST 成功已 setQueryData；详情 staleTime=0，有立即后台回源的可能                                     | TEST 核对真实 POST/GET 次数；仅对刚创建且响应完整的会话使用窄范围 freshness/首次挂载策略，立即消费返回的开场白         | 不全局禁用详情刷新；旧会话、多端状态、streaming 轮询和取消恢复仍回源；不得误称当前必然串行 POST→GET 才 ready                  |
| 创建请求未设置显式业务 timeout；详情单次 10s，query 默认可重试一次                                   | 在既有 hook/API 层分开设计创建与读取预算；错误码映射覆盖业务失败；保留入口同步防双击                                   | 创建是写：超时可能已提交，禁止自动重发。已有空会话复用不是数据库并发幂等保证；结果未知恢复需单独验证，必要契约变更先审 shared |
| ready 取决于有效会话及详情 isSuccess；Splash 初始不 ready 时，ready 后仍有 240ms 填充 + 720ms 退场   | 将数据 ready 与实际可交互分开打点；拟缩短/取消 ready 后强制等待，快速成功直接退出，慢请求保留反馈；支持 reduced motion | 约 960ms 是代码定时器之和，不是现网测量；挂载已 ready 会跳过。不能仅露出页面就提前解除 serverBusy/取消中的发送限制            |
| 页面挂载并发读模型、用户、语音、图片等，代码未把它们全部列为 ready 条件                              | 先量化请求及渲染竞争；非当前可见/必要的资源按已有 hooks 的 enabled 条件延迟，避免新增总加载闸门                        | 模型/额度判定和历史媒体不能丢失；不得凭空将旁路查询写成串行阻塞原因                                                           |
| 建会话内部读取角色→空会话→可能插入是串行路径；显示名已并行                                           | 对每段计时，优先请求内复用安全数据，消除无变化资料写；只有 SQL 证据才考虑查询/索引                                     | 角色可见性、用户归属和空会话复用保持；不为并行提前创建未授权会话                                                              |

源码注释差异：E16 ChatSplash 仍有 ST/iframe/bridge 历史描述，但实际 ready 来自当前自研会话状态；此次以实现为准，不恢复已退场链路。实施时可同步修正该处误导注释。

**Sentry 对 N 的约束（E18）**：`GET /api/characters/:id` 是最高频后端交易（7d≈21.5k），p50≈80ms 但 p95≈10s，并已有 N+1 Query Issue（ST-MINIAPP-3M）。进入会话优化不能只改开屏动画：必须把详情 API 长尾与前端预取/N+1 一并验收。`/chat/:characterId` pageload p95≈7s 作为入口前端基线快照，改后同窗口对照。

## 4. 消息发送后的首字、流式速度与完成速度（S）

```text
浏览器 SSE → 配置的 API 地址 → Telegram 鉴权、用户/会话 ownership
→ 并行：模型、角色、用户生成配置、显示名、平台规则、上下文限制
→ 陈旧流恢复 → 原子开轮 → request id/上下文/prompt 快照
→ execute：定价/模型计费配置/VIP 策略 → charge id → 额度预留/余额检查
→ provider 偏好 → 计费快照/供应商占位 → dispatch
→ 上游响应/流打开 → SSE start → 首个正文 delta → 浏览器首字渲染
→ 终态 CAS、额度处理、结算与恢复
```

不是所有读都串行；E5/E6 已使用 Promise.all。SSE start、上游 HTTP headers、首个 content token 是不同事件。生成后的异步结算不直接计入首字，但并发结算/恢复任务可能争用下一次请求的资源。

| 项目       | 当前 CODE                                                                                       | 拟优化后（待批准）                                                           | 不能破坏的边界                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 平台规则   | E5 显式读取；E8 getGenerationConfig 内又读；E7 缓存命中前仍读数据库版本/值                      | 本轮只取一份规则快照，偏好校验和 prompt 共用；减少重复读而非增加并行峰值     | runtime-config 仍是唯一入口；不可混用不同版本规则                                |
| 用户设置   | 生成配置/显示名分别读取同表；settings/models 的 getOrCreate 对已存在行仍刷新 Telegram 资料      | 先测调用次数；请求内聚合读取；资料相同不 UPDATE                              | 保留首次创建竞态处理；不缓存跨用户鉴权/钱包/额度                                 |
| 模型目录   | 选择模型和计费上下文可能再次查目录，version 缓存不等于免 DB                                     | 评估同轮不可变快照传递，确保选型/计费一致                                    | 下线/VIP/价格生效语义先审核；不能仅为省读跳过权限                                |
| 业务写入   | 开轮、预留、计费快照、provider 占位位于 dispatch 前                                             | 保留依赖顺序，仅合并被证实重复的安全读取                                     | 不把预留/快照移到首字后，不并行破坏提交顺序，不盲重试生成                        |
| 超时       | 准备读约 20s；会话活跃生成控制器以入口时间约 110s 为界；execute 有 120s signal；多处 DB 调用 5s | 审核实际 signal 传播，补齐关键只读调用；把“停止等待”与“底层请求取消”分别验收 | Promise race 只拒绝等待，不会自动取消底层；写超时可能结果未知，须查权威状态/补偿 |
| 浏览器等待 | SSE idle=130s、总 deadline=150s；心跳不延长无正文等待                                           | 复用现有机制，加阶段观测而非又造 parser                                      | 浏览器断开不能直接认定服务端取消成功                                             |
| 取消轮询   | 每次检查完成后约 1s 再查下一次状态                                                              | 记录活跃生成数、轮询量及耗时，按证据评估节奏                                 | 不默认降低取消响应速度；不改成进程 Map 作为跨副本事实                            |

20s/110s 等是现有代码的控制边界，不是保证每次 HTTP 响应一定在该时间内完成；清理、写入和未响应 signal 的依赖需要单独验证。

### 4.1 “回复慢”不能只验首字

将一次发送拆成：点击→请求发出、请求→dispatch、dispatch→上游首正文、首正文接收→绘制、首正文→末正文、末正文→done/服务端终态回读。分别记录浏览器总时长与各端本地 duration，不用未校准的浏览器/服务器绝对时间相减。

主要改动先落在 E5–E8 的同轮规则、设置、模型只读快照复用，减少准备期 DB/HTTP 次数，不盲目再加 Promise.all。若耗时集中于上游，按 provider/model、输入/输出规模、网络分组比对首正文和正文速率；不能通过默认换便宜模型、减少用户要求字数或裁掉必要上下文冒充优化，模型策略变化另审质量与计费。若接收 delta 很快但绘制慢，再定位解析/React 提交成本，在现有流式 hook 内评估有界更新合并，不另造 SSE parser；终态必须立即正确收敛，不漏字、不乱序。若末正文后迟迟不完成，定位终态写入、结算及回读，不以提前 done 绕过权威终态。

UI 可即时显示发送中，但不能把占位、SSE start、心跳、reasoning 或进度提示当成“回复首字”。验收同时覆盖首字、流中长停顿、完整回复时长和失败率。

**Sentry 对 S 的约束（E18）**：

- `POST .../messages` / `regenerate` 的高 p95/p50 **大部分可归因于 LLM 生成**；P1-A/P1-S 必须用分段计时证明「准备期」或「连续 HTTP」收益，禁止把供应商推理变短写成产品优化成功。
- Consecutive HTTP（ST-MINIAPP-2G）指向对 `current_chat_history` 的连续 PostgREST 调用；与同窗 Supabase `current_chat_history` >5s（190 次）交叉验证，优先合并/缓存安全只读，不扩大并行峰值。

## 5. Prisma、Supavisor 与 PostgREST 必须分开排查（C）

### 5.1 当前机制

- E9 为 Prisma 6.19.3、prisma-client-js，未配置 driver adapter；业务源码仅检出一个 PrismaClient 初始化，另一个位于 seed。**单进程单例不等于全站单池**：每个 API 副本、独立 Worker/脚本可能各有池。
- Prisma 本地池的 connection_limit、pool_timeout、connect_timeout，与 `$transaction` 的 maxWait/timeout、Postgres statement/lock timeout 不是一回事。生产实际值未读取，不把官方默认值当作运行值。
- Prisma 的 TCP 连接可能经 Supavisor，也可能直连：必须在目标服务内核对模式、参数及控制台。只记录脱敏类别/数值，不打印连接串、用户名、密码或完整环境变量。
- Supabase-js 是 HTTP/PostgREST 客户端，不共享 Prisma 本地池；两者仍会竞争同一个 Postgres 的 CPU、I/O、锁和服务端连接。更改 Prisma pool 不会直接扩大 PostgREST 的池。
- 已读 AI 路径未发现用 Prisma 交互式事务包住整个 LLM 流；不能声称“一条 SSE 始终占一条 Prisma 连接”。RPC 内事务/独立查询各自占用连接，取消轮询和并发结算另有成本。

### 5.2 已发现的重点风险

**大厅排序刷新（E10）**：启动约 30s 后运行，此后每日；与在线路由共用 Prisma；maxWait=15s，事务 timeout=10min。事务级 try advisory lock 防重叠，同一 tx 做聚合与落表；配置 HTTP 读在事务外。风险是长事务占一条连接及聚合 CPU/I/O，**不是已证实耗尽，也不是所有副本同时执行聚合**。需对齐部署重启、job duration 与在线延迟。停定时器不等于取消正在执行的事务。

**支付告警历史（E11）**：10-12 文档记录 P2024，当前使用 DIRECT_URL 专用 pg Client 持 session advisory lock，连接/查询 timeout 为 8s。须确认现网含修复；专用连接也计入 DB 预算。其 finally 的 unlock 异常分支可能在 end 前抛出，应在后续故障注入中验证“解锁失败仍关闭”；本轮不扩大为支付重构。

**缓存刷新/HTTP 请求滞留**：分数缓存过期并发回源、配置每次查版本、缺失底层 abort，都可能延长资源占用。增加 Promise.all 会降低串行 RTT，却可能放大瞬时并发；优先去重，再考虑并行。

### 5.3 预算与调参原则

分别核算两层，不能把 pooler client 数直接当 Postgres backend 数：

```text
应用到池化端的客户端预算 = Σ(各服务进程数 × 各进程池上限) + 临时客户端
Postgres 连接预算 = 直连 + 各 pooler 后端连接 + PostgREST/Auth/Storage 等服务连接 + 运维余量
```

滚动发布的新旧副本重叠也计入。采集峰值/等待/事务时长后才选择：缩短占用、减少并发、限后台工作、调整池大小或 compute。Supavisor session/transaction 模式和 prepared statement 兼容性必须按实际端点及官方说明核对；不直接套用端口或批量加 pgbouncer 参数。

P2024 表示获取 Prisma 池连接超时，并非自动证明 Postgres max_connections 已满；P2037/too many connections 指向连接上限问题，也要定位发生层。提高 pool_timeout 可能只是让页面更久才失败；设为无限等待不是优化。

官方机制参考（沿用前轮链接，本次未重新获取，不作为生产配置或当前网页内容证明）：[Supabase Prisma 排错](https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting)、[Prisma 连接池](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool)。实施前按已安装版本重新核对，不照搬 v7 adapter 配置。

### 5.4 连接容易满、其他请求连不上：核心改动设计

**先交付容量表，再落具体参数**：由运维确认每个 API/Worker/脚本的副本及进程数、连接模式、池上限、连接等待/事务预算、峰值使用量和滚动发布重叠。只保存数值与类别，不保存 URL/秘密。在线请求、必要恢复任务及运维分别预留余量；预算是容量规划，**同一个 Prisma 池并没有天然的按请求优先级保留通道**。

| 治理项            | 拟修改范围与动作                                                                                                                                                  | 验证与恢复                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 连接上限和排队 | 沿用 E9 单进程单例；按全服务预算核对/显式配置各进程池大小与有限 pool_timeout/connect_timeout，经现有启动配置入口校验。不得给每个请求/模块新建 client              | TEST 小池饱和，区分 P2024 与服务端连接拒绝；记录等待、错误率、吞吐和恢复时间。无容量数据前不填任意“推荐连接数”                                    |
| C2 后台竞争       | E10 保留本地 isRunning + 事务级 try lock；按证据错开启动聚合、限制后台并发、为聚合设置有界执行窗口。优先调度/减少工作量，不默认增加独立池                         | 单任务/双副本/滚动启动对照，在线列表与建会话仍可完成；聚合失败旧快照不丢。10min 是当前上限，不是实测耗时；缩短事务需有查询取消/回滚证据           |
| C3 异常释放       | E11 修正 unlock 异常不应跳过 end 的清理结构；连接建立半失败、work 抛错、清理回调抛错均验证关闭尝试及错误记录。审查 API/Worker 退出时在途 drain 和 client 生命周期 | 故障注入后连接占用回落；保持主错误与清理错误可追踪。复用长驻单例，不在每个请求后 disconnect；进程退出没有显式 disconnect 不能直接等同生产连接泄漏 |
| C4 防止请求放大   | 大厅/排序刷新合并，取消离页只读请求，限制安全读重试；若去重与调度后仍过载，在具体高成本入口加有界准入/快速失败，不新建全局排队框架                                | 等待队列不能无限增长；429/503 语义与既有 shared envelope 对齐，必要新增错误码先改契约。生成/建会话结果未知不自动重试                              |
| C5 可观测与恢复   | 复用 pino 记录操作类别、等待/执行/事务时间、job 时长和错误分类；无可用池等待指标时明确标 GAP，不把总查询耗时当池等待                                              | 负载撤去后无需人工重启即可恢复到对照稳态；停止非关键新任务不是中止已有事务，不停关键结算恢复                                                      |

C1/C2/C4 必须证明是否保护了同库的 PostgREST 和其他服务，而不只看 Prisma 报错减少。客户端多开池不能隔离 Postgres CPU/I/O；若确需独立后台池/Worker，须在既定总连接预算内重新分配，并作为后置设计审核。不能以全部请求快速失败、延长 pool_timeout 或扩 API 副本来宣称连接满已解决。

**Sentry 对 C 的约束（E18）**：近 7 天大量 `http.client` 到 Supabase REST 卡在 ≈300s（`users` / `runtime_config` / `current_chat_history`）。这更像 **HTTP 客户端超时上限被打满**，与「Prisma 本地池耗尽」不同层。P0-C 容量表必须同时列 Prisma 与 PostgREST/supabase-js 超时；P1-C 验收要看这两类慢调用次数与 p95 是否同降，不能只看 P2024 减少。

**异常与止损顺序**：确认瓶颈层→经批准限制非关键新工作/减少重试放大→保存脱敏指标→修复占用/释放与预算→TEST 恢复验证→生产小批次对照。重启仅是独立批准的应急手段，不能作为长期修复或本轮执行动作。

## 6. 排查矩阵及只读验证顺序

| 现象                   | 假设                           | 验证方法                                                                       | 判定/下一步                                          |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 大厅慢、其他 API 正常  | 代理额外网络跳转/等待 body     | 同窗口测浏览器→代理、代理→Railway、后端处理阶段；核对部署区域和版本            | 代理阶段占大头才讨论入口/缓存；不先删代理            |
| 冷启动慢、热启动快     | TLS/冷实例/缓存失效            | 分离新连接与复用连接，冷/热 localStorage、进程缓存、发布后请求                 | 与各阶段关联，不能用 health 总耗时当 DB 耗时         |
| skeleton 长期不退出    | fetch 未完成、总预算缺失       | TEST 注入 headers 挂起、body 挂起、离页/断网；记录 retry 次数                  | 在约定 deadline 后进入可重试状态，无后台持续请求风暴 |
| 列表可用但图片慢       | 资源传输/解码                  | 脱敏 Network 与渲染时间线分开标记                                              | 只改资源路径，不误优化 SQL                           |
| 点击进入后仍卡顿       | 导航资源、创建/详情或开屏等待  | 分开记录确认进入→路由挂载→POST/GET→ready→开屏退出；新会话/历史会话分别采样     | 接口快但 ready 后慢则改开屏；POST 慢才查建会话链路   |
| 创建成功后额外 GET     | 缓存立即 stale 或主动失效      | 检查创建回填、query 挂载/失效及请求次数                                        | 验证窄范围 freshness，不停用全局详情/streaming 刷新  |
| AI start 快、正文慢    | 供应商排队/推理或客户端渲染    | dispatch→首 content、收到 delta→绘制，按模型/provider/prompt 长度分组          | 供应商为主则不归因 Prisma；不记录 prompt 正文        |
| AI dispatch 前慢       | 重复读取/串行 RTT/DB 等待      | identity、ownership、read batch、startTurn、prompt、reserve、snapshot 分段计时 | 根据累计等待与调用次数选前两项优化                   |
| 首字正常但回复整体慢   | 上游流速、绘制拥塞或终态等待   | 分离首/末正文、delta 接收与绘制、done 和终态回读；按输出规模分组               | 不以减少输出或提前 done 掩盖问题                     |
| P2024 且 DB 连接不满   | 本地池小、慢查询占用、任务争用 | 同时看 Prisma 等待、pool 配置、事务时长、job 日志、实例数                      | 先缩短持有/限制并发，再讨论池大小                    |
| P2037/拒绝连接         | 全站连接预算超限               | 所有服务/滚动副本、pooler client/backend、PostgREST/直连预算                   | 限流/错峰/减少池，不无脑增加 API 副本                |
| SQL 慢且 lock wait 高  | 写热点/长事务阻塞              | 运维只读聚合事务年龄、wait_event、阻塞数量；不导出 SQL 正文                    | 区分锁等待与扫描；TEST 重现后缩短事务                |
| 发布后约 30s 明显变慢  | 排序 job 与请求竞争            | job start/completed/failed 对齐 CPU/I/O、连接与请求 p95                        | 相关不等于因果；TEST 对照运行/不运行 job             |
| Prisma/HTTP 同时慢     | DB 资源或区域网络问题          | Railway 同运行环境分别测极小 Prisma 读与 PostgREST 读，配 CPU/I/O 曲线         | 两类 RTT 独立记录；不以本机结果替代容器结果          |
| 旧数据刷新失败后变空白 | error UI 覆盖已有缓存          | 缓存预热后断网、推荐/最新切换与返回恢复                                        | 保留旧数据且明确陈旧状态，服务端继续校验可见性       |
| p50 正常、p95≈60s      | 偶发超时/下游卡住/池等待       | Sentry 同交易 p50/p95/count；抽样慢 trace 看卡在 Prisma、PostgREST 还是上游    | 先有界等待与超时出口，再对症修下游；勿只优化中位数   |
| `/chats` 卡顿          | 对 characters 的 N+1 HTTP      | 对照 ST-MINIAPP-1Y；Network 计 `/api/characters/*` 次数与并行度                | 批量化/缓存命中后 Issue 复发率下降                   |
| messages 整体慢        | LLM vs 连续 PostgREST          | 对照 ST-MINIAPP-2G；分段 prepare vs provider vs history HTTP                   | 只把非 LLM 段计入可代码优化收益                      |
| 多接口同现 ≈300s       | supabase-js/HTTP 超时打满      | 聚合 E18 Supabase >5s 表；核对 timeout 配置与 DB CPU/连接                      | 区分应用超时与 Postgres 慢查询                       |

执行顺序：

1. **身份/环境**：确认 Production 项目、服务、部署 SHA、前端构建目标、时区、区域、副本和 Worker 清单。当前未知项保持 GAP。
2. **复现资料**：补充变慢起点、推荐/最新/聊天哪个页面、冷/热启动、用户网络、模型；提供脱敏 HAR/请求 ID，不收集 initData、cookies、正文或余额。
3. **被动观测优先**：同一时间窗查看 **Sentry（E18）**、Railway 请求/job 日志、CPU/内存/重启，Supabase CPU/I/O/连接/锁等待；现有指标优先，不默认部署新观测平台。改前后用同一 Sentry 查询窗口对照。
4. **安全低频探测**：另行确认环境后由运维在 Railway 内做两类极小只读探测，设连接/总超时、有限样本、不并发压生产、不触发生成/写入。Supabase MCP 本项目仅用于确认目标后的只读结构采集，业务行与运行态采样不通过 MCP 执行。
5. **定位 SQL**：只提交脱敏聚合及查询标识；先 EXPLAIN 不执行实际查询，EXPLAIN ANALYZE 仅在 TEST 或明确批准的有界场景执行。慢 SQL 证据出现前不加索引。
6. **TEST 对照**：用合成数据/假上游注入超时、池饱和和 job 重叠；实际模型及 Telegram 真机另行批准。每组至少报告样本量、窗口、环境、错误和失败率，不能只挑成功请求。

## 7. 指标、目标与验收

| 指标                                    | 定义                                                             | 目标性质                                                                            |
| --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| lobby_usable_ms                         | 用户打开大厅到首批卡片可交互，冷/热分组                          | Sentry 快照：`/` pageload p95≈12.6s（E18）；候选优化后同负载 p95 降低 ≥30%，审核后门禁 |
| lobby_api_p95_ms                        | `GET /api/characters` 服务端交易 p95                             | Sentry 快照：p95≈60s / p50≈106ms；目标先压长尾（候选：p95&lt;3s 或降 ≥50%），审核后定 |
| lobby_fresh_ms                          | 列表请求发出到新数据应用；与旧快照可用时间分开                   | 不以显示旧卡冒充实时数据变快                                                        |
| chats_n1_events                         | ST-MINIAPP-1Y 类 N+1 API 事件/影响用户                           | 快照：1337+ events / 125 users；改后同窗口显著下降且无功能回退                      |
| entry_ready_ms / entry_usable_ms        | 确认进入到会话数据 ready / 消息可见且输入可交互；新建与历史分组  | Sentry 快照：`/chat/:characterId` pageload p95≈7s；entry_usable p95 降 ≥30% 待审    |
| character_detail_api_p95_ms             | `GET /api/characters/:id` p95                                    | Sentry 快照：p95≈10s / count≈21.5k；长尾与 ST-MINIAPP-3M 同降                       |
| entry_post_ready_ms                     | ready 到开屏不再阻挡；挂载已 ready 单列                          | 候选目标 ≤200ms（非忙碌场景，需产品审核）；现有 240+720ms 不当作实测基线            |
| backend_prepare_ms                      | 后端收到发送请求到上游 dispatch（**不含** provider 推理）        | 基线待采；同模型/输入规模下 p95 降低 ≥30% 为候选目标；与 messages 总 p95 分开报告   |
| provider_first_content_ms               | dispatch 到上游首个非空正文 delta                                | 独立报告，不将心跳/role/reasoning 当正文；messages 总 p95≈66s 多半落在此段          |
| browser_first_text_ms                   | 点击发送到首个正文绘制                                           | 含网络/后端准备/供应商/渲染，不简单相加各分位数                                     |
| reply_complete_ms / stream_gap_ms       | 点击发送到确认终态；正文 delta 间隔及绘制延迟分别记录            | 同模型/输入输出规模对照完整时长与长停顿；首字变快不能以流速或终态退化为代价         |
| consecutive_http_events                 | ST-MINIAPP-2G / `current_chat_history` 连续调用                  | 快照：39+；改后同窗口下降，且不增加准备期并行峰值                                   |
| supabase_rest_gt5s_count                | 对 Supabase REST duration&gt;5s 的 http.client 次数（按表）      | 快照：users 817 / current_chat_history 190 / runtime_config 125；P1-C 后同降        |
| db/queue/transaction_ms                 | 每类 DB 调用、可观测池等待、事务持有时长                         | 不把 SQL 执行时间等同等待时间；无池指标时标记缺口                                   |
| db_recovery_ms / unaffected_api_success | 过载撤去到稳态恢复；任务压力下其他 API 成功率和 p95              | TEST 审核负载下不持续连接拒绝、不无限排队；超预算流量可有界拒绝，正常流量不能被饿死 |
| reliability                             | 超时、P2024/P2037、429/5xx、取消待确认、残留 streaming、结算失败 | 与延迟同时比较，不能靠更早报错降低成功请求 p95                                      |

大厅初始候选总预算为 **15s（含一次允许的重试和 body 读取）**，代理应比浏览器预算更短并留回传余量；这是待 TEST/产品审核的目标，不是当前实现。重试只在总预算内对瞬时安全读做有限退避；400/401/403 不自动重试。AI 优先保留现有窗口，不以延长等待掩盖退化。

日志复用现有 pino/requestLogger：请求 ID、阶段、duration、结果类别、调用计数、缓存状态、部署版本；每阶段采样汇总，不逐 token 打日志。原始异常使用 `{ err }` 并遵守脱敏边界；不记录连接串、配置值、个人资料、prompt、消息正文或完整响应。

必须通过的失败场景：无缓存失败、有缓存刷新失败、body 挂起、切 tab/返回恢复、断网/离页；鉴权失败/非本人会话；配置缺失/过期/更新；额度不足、预留超时结果未知、取消与完成竞态、上游无正文/缺 done、重复请求；排序任务重叠/锁未获取/中途失败/空结果；池等待与并发恢复。不得出现重复扣款、额度泄漏或提前解禁会话。

补充专项验收：详情缓存冷/热及路由预取未命中；快速连点、进入后离页、创建结果未知、旧会话刷新和多端生成；无正文/有正文慢流/末正文后无 done；解锁失败仍关闭、连接半失败、滚动新旧副本重叠、长事务与普通读竞争。四主线分别提交基线与改后 p50/p95、样本数、失败率及副作用，不用单一“整体变快”结论替代验收。

## 8. 最小改动批次、依赖和回滚

| 批次         | 限定模块 / Sentry 驱动项                                                                 | 进入条件                                                         | 交付/恢复                                                                 |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P0-A         | 固化 E18 基线快照 + L/N/S/C 分段观测字段；对照表写入本文件或运维笔记                     | 审核日志字段和环境；不加新依赖                                   | 小提交，撤销新增采样即可；无 DB 变更                                      |
| P0-C         | C1–C5 连接容量表；**显式包含** supabase-js/PostgREST 超时与 ≈300s 慢调用                 | P0-A 同窗口连接证据、TEST 故障方案                               | 明确核心修复范围，批准后实施；不等待深度 SQL 调优                         |
| P0-B         | E1/E2/E3 大厅等待/取消/失败出口（防 60s 挂死）；E5/E7/E12 必要 signal 传播               | 预算审核；先区分只读与关键写入                                   | 保持 shared envelope；独立回滚请求策略，不改变业务事实                    |
| **P1-L-N1**  | **前端** `/chats` 对 `/api/characters/*` 的 N+1（ST-MINIAPP-1Y）                         | G1 审核；不改变角色可见性契约                                    | 批量/缓存/去重后 Issue 与请求次数下降；独立回滚前端                       |
| **P1-L-TAIL**| **后端** characters / latest-badge / favorites 长尾（p95≈60s/13s）与 Supabase `users`    | P0-B 有界等待已规划；同窗慢 trace 抽样                           | 压 p95 长尾；不恶化 p50/错误率；回滚读路径                                |
| **P1-N-DETAIL** | **后端** `GET /api/characters/:id` 长尾 + N+1 Query（ST-MINIAPP-3M）                  | 与 P1-L-N1 可并行；审核查询边界                                  | p95 与 Issue 同降；保留 ownership/可见性                                  |
| P1-N         | E14–E17 入口缓存/创建预算、旁路负载与开屏退场                                             | 新建/历史两分支证据；建议在 P1-N-DETAIL 有进展后或并行审动画方案 | 先小范围调整 ready 后等待，再按证据改请求策略；不改变会话所有权           |
| **P1-S-HTTP**| messages 路径 Consecutive HTTP → `current_chat_history`（ST-MINIAPP-2G）                 | 与 LLM 分段拆开；证明非推理段收益                                | 合并/复用安全只读；不增加并行峰值；独立回滚                               |
| P1-A         | E5/E7/E8 请求内只读快照复用、资料条件更新                                                | 分段耗时证明 **prepare** 收益；审核配置生效语义                  | 不新增公共 API；旧调用兼容，回滚恢复原读路径                              |
| P1-B         | E4 的现有排名缓存刷新合并，必要的有限 TTL                                                | 确认回源峰值；运营同意陈旧窗口                                   | 保留旧快照/运营顺序兜底；回滚仅恢复读策略                                 |
| P1-C         | E9/E10/E11 预算内池参数、后台竞争、异常清理；**验收 supabase_rest_gt5s_count**           | P0-C 审核；按层定位、TEST 过载及恢复                             | 一次只改一个池/并发/调度/超时维度；保存旧值与部署 SHA                     |
| P1-S         | E3/E6 的流速/绘制/终态定点优化                                                           | 分段证明首字之外、且非 LLM 供应商段的瓶颈；不默认全部实施        | 保留完整正文、done/取消/计费语义，独立回滚                                |
| P2           | 被证实的具体慢 SQL/索引、隔离部署或容量                                                  | 核心批次仍不足，连接/锁/CPU 证据、TEST 复现                      | 另审迁移或部署；不作为核心四主线交付的替代                                |
| **P2-X**     | `telegram/webhook`、`growth/miniapp-entry` 中位数/p95 偏高（E18）                        | 四主线核心批次后另审；可能跨 Bot/增长域                          | 不阻塞大厅/会话/回复主线；单独范围与回滚                                  |

不默认给后台 job 新建池：独立池可隔离本地排队，但可能增加总连接且不能隔离 DB CPU。先评估低峰调度/限制重叠和聚合成本；事务级 advisory lock 与同连接聚合/落表不可随意拆开。暂停排序刷新须批准，已有汇总仍可读取，不是必然退回运营顺序；持续陈旧要有观察时限和恢复责任人。不得关闭关键结算/恢复任务来换取表面性能。

发布顺序：TEST 故障注入和消费者检查 → 兼容后端观测/改动 → 前端 → 小范围流量 → 同窗口对照 → 扩大。若生产不支持用户级灰度，不假装已有开关；先 Preview 验收，再批准低峰逐服务滚动发布。观测到计费/权限/取消异常立即停止；候选性能停止线为同负载 p95 恶化 >10% 或错误率增加 >0.5 个百分点（须经审核并结合样本量）。

本方案无迁移、无新对象、无旧数据回填。若 P2 确认需要索引/函数，必须另补八域归属、权威写入方、不变量、消费者与跨 schema 依赖，使用唯一 migration 目录并逐文件 TEST 验证，再批准生产。回滚代码不得回滚已发生的账务事实；在途预留/结算继续由原幂等恢复路径收敛。

## 9. Sentry 驱动优化设计入口

分批「改什么 / 不改什么 / 验收 / 回滚」的可实施设计已写在 Trellis：

`.trellis/tasks/10-21-production-request-performance/design.md`

源码回读结论摘要（细节以 design.md 为准）：

| 批次 | 根因（CODE+SENTRY） | 首选改法 |
| ---- | ------------------- | -------- |
| P1-L-N1 | `/chats` 逐行 `useCharacterQuery` | 用大厅摘要缓存补头像；仅 miss 打详情；禁止 Summary 灌 Detail cache |
| P1-N-DETAIL | 详情并行全量 id `findMany` + 多路 Prisma | 60s featured 快照 + 收窄 select |
| P1-L-TAIL | favorites 为金框再扫全大厅；badge 受 users 超时拖累 | favorites `id in`；badge/列表配合 P1-C abort 与 single-flight |
| P1-S-HTTP | 泄洪后 context 两次 `current_chat_history` GET | 合并为单次 OR 查询；复用 RPC 窗口起点 |
| P1-C | supabase 无 `db.timeout` → undici ≈300s | 全局有界超时 + 热路径 signal；与 Prisma 池分列 |

本文 §8 批次表与 design.md 顺序一致；**实施前须完成 design.md §7 审核门禁**，本轮仍不写产品代码。

## 10. 交付边界

本轮只完成规划与静态文档检查（含 Sentry 归纳与优化设计），不代表任何性能指标已改善，也不代表生产根因已全部定位。后续实施必须先审核本文件及 Trellis `design.md`，补齐环境、基线与验收预算。生产取证、故障注入、真实 AI 生成、配置调整和迁移均不在此次执行范围。
