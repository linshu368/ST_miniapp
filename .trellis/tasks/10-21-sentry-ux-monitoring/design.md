# 设计：Sentry 体验与可用性监控

依据：`prd.md`、`research/pool-findings.md`。事实来源标注为"已核实"或"待验证"；待验证项在 T0 里逐条确认，不得当成事实写进代码注释。

## 1. 复用调研

| 已有                                          | 位置                                                                            | 处理                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 前端 Sentry 初始化、脱敏钩子、Replay 延迟加载 | `frontend/src/instrumentation-client.ts`、`lib/sentry/client.ts`                | 扩展：改采样、加标签与 processor                                             |
| 统一 HTTP 客户端                              | `frontend/src/lib/api/client.ts`（`apiClient`）                                 | 扩展：耗时、超时、in-flight 登记。所有请求已经走这里，不新建 fetch 包装      |
| React Query 默认项                            | `lib/api/query-client.ts`（`retry: 1`）                                         | 不改；在 apiClient 层记录每次尝试                                            |
| 后端 Sentry 初始化、请求上下文                | `backend/src/instrumentation.ts`、`lib/sentry.ts`、`app.ts` 的 `onRequest` 钩子 | 扩展：加 `onResponse` 耗时、采样                                             |
| 脱敏                                          | `packages/shared/src/telemetry/sanitize.ts`                                     | 修：加深度/节点上限                                                          |
| 飞书告警                                      | `backend/src/features/alerting/`                                                | 最后一期复用，本期不动                                                       |
| PostHog 回放遥测                              | `frontend/src/lib/telemetry/`                                                   | **不复用**：它服务回放与支付归因，生命周期和事件白名单不同，混入会污染其契约 |

已核实的现状：

- `@sentry/nextjs` 10.69.0。前端 trace 里已有 `ui.long-animation-frame` span，说明长任务/LoAF 采集已默认开启，INP 同理默认由 browserTracing 采集（待验证面板里能看到）。
- 前后端 trace **未串联**：前端 trace `035c37b32d5a45d39396050f36184f10` 只含前端 span。前端域名 `app.themijing.com`，后端 `stminiapp-production.up.railway.app`，跨域；SDK 默认只给同源请求加 `sentry-trace`。后端 CORS 的 `allowedHeaders` 已包含 `sentry-trace`、`baggage`，无需改。
- 现在前后端 `tracesSampleRate`/`tracesSampler` 为全采，前端 Replay 会话采样 1.0。
- 后端 `/health` 只返回时间戳，不访问数据库。

## 2. 最小充分方案

三条原则：

1. **不依赖采样的指标走 Sentry Metrics**（distribution/count），trace 与 Replay 才可以降采样。p95/p99 看板用 metrics，不用抽样后的 span。
2. **"卡了"用事件表达**：`page_stall`、`action_stall`、`slow_request` 作为 Sentry 事件（`captureMessage`，warning 级），全量上报，带 Replay、标签、requestId、在途请求。
3. **新增代码集中在两个小模块**，不做通用框架：
   - 前端 `src/lib/perf/`：`inflight.ts`（在途请求登记）、`page-tracker.ts`（页面就绪与看门狗）、`action-tracker.ts`（按钮反馈）、`env-tags.ts`（设备/网络标签）。
   - 后端 `src/lib/perf-metrics.ts`：路由耗时 hook、事件循环延迟、DB 操作耗时。

拒绝的方案：自建上报管道或接入第三方 RUM（Sentry 已够用，且要和 Replay 关联）；给所有按钮自动埋点（噪声大，只做三个核心动作）；Service Worker 级拦截（侵入大）。

## 3. 前端设计

### 3.1 请求耗时（`apiClient`）

每次 `fetch` 尝试：

- 开始时登记到 `inflight`（path 模板、startedAt、requestId），结束时移除。
- 结束时发 `Sentry.metrics.distribution('api.request.duration', ms, { unit: 'millisecond', attributes: { route, method, outcome } })`。`outcome` ∈ `ok | http_4xx | http_5xx | timeout | network`。`route` 用路径模板（`/api/characters/:id`），不得带 id、query。
- 增加客户端超时：`AbortController`，默认 20 秒；对话生成/SSE 与语音、图片生成这类长耗时接口不套该超时（单独走各自的现有超时）。20 秒是**初值**：既要覆盖正常长尾（普通接口 p95 偶发 10 秒），又不能让用户无限等。超时抛带 `code: 'client_timeout'` 的 `ApiClientError`，调用方现有错误路径处理。
- 耗时 ≥ 3 秒或 outcome 非 ok 时，额外发 `slow_request` 事件（同一 `route+outcome` 每会话每分钟最多 1 条，防刷）。事件带 `requestId`、耗时、在途请求数、本页已进入秒数。
- `requestId` 沿用现有 `X-Request-Id`，与后端日志/事件的 `request_id` 标签对应。

### 3.2 页面就绪与看门狗

`page-tracker.ts`：路由变化（`usePathname`）时开始计时，登记 `routeTemplate`，4 秒看门狗；页面通过 `markPageReady(name)` 宣告可用。就绪耗时发 `page.ready.duration` distribution。到 4 秒仍未就绪：发 `page_stall` 事件，附 `inflight` 快照（路径模板、已等待时长）、`coldStart`（是否本会话第一个页面）、网络标签；事件一律 flush 缓冲 Replay。

初版"可用时刻"定义（待负责人确认，对应 PRD 待决问题 1）：

| 页面                        | 可用 =                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 大厅 `(main)/page.tsx`      | 角色卡列表首次渲染出内容（缓存或网络均可）；另记 `page.data_fresh.duration` = 最新列表到达。大厅有本地缓存秒开（`useCharactersQuery` 的 `initialData`），不分开记会把后端慢掩盖掉 |
| 聊天列表 `(main)/chats`     | 会话列表渲染                                                                                                                                                                      |
| 会话页 `chat/[characterId]` | 历史消息渲染（或确认为空会话）                                                                                                                                                    |
| 充值 `profile/recharge`     | 套餐列表渲染                                                                                                                                                                      |

其余页面只记路由耗时，不设看门狗。

"刚进去最慢"验证：每次页面开始后 10 秒，发一次 `page.entry_window` 汇总（该页前 10 秒请求数、其中慢请求数、`coldStart`），按 `coldStart` 与 `route` 切分。

### 3.3 按钮反馈

`action-tracker.ts`：`startAction(name)` 返回 `{ feedback(), fail() }`，2.5 秒内未调用 `feedback()` 则发 `action_stall`。只接三个动作：

- `select_character`：点击到进入会话页并显示首屏骨架/内容。
- `send_message`：点击到用户消息出现在列表。**首字延迟另记，不套 2.5 秒**（对话 p50 约 16 秒），本期只采集分布。
- `recharge_create_order`：点击到订单创建响应或错误提示出现。

### 3.4 资源与环境

- 资源加载失败：监听捕获阶段 `error`（script/link）与 `unhandledrejection` 里的 `ChunkLoadError`，发 `asset.load_failed` count（attributes 含资源类型，不含完整 URL query）和事件（含脚本文件名）。分母用 `page.ready.duration` 的页面数。
- 环境标签（init 时设一次，网络标签在事件处理器里取最新）：`tg_platform`、`tg_version`（来自现有 Telegram SDK 初始化）、`device_memory`、`cpu_cores`、`net_type`、`net_rtt_bucket`、`coldStart`。Metrics attributes 只用低基数字段（route、outcome、tg_platform、net_type、release、environment）；`telegram_user_id` 只出现在事件上，已有 `setTelegramUser`。
- 页面可见性：记录 `visibilitychange`，页面在后台期间不计入看门狗（暂停计时），避免误报。

### 3.5 脱敏修复

`sanitizeValue` 增加深度上限（初值 30）与节点计数上限（初值 20000），超限返回 `[Truncated]`，不再无界递归。`beforeAddRecordingEvent` 的回放事件体量大，改为只做浅层字符串脱敏，不对整棵 DOM 快照递归。

## 4. 采样

| 项                   | 现在               | 改为                                            | 理由                                    |
| -------------------- | ------------------ | ----------------------------------------------- | --------------------------------------- |
| 前端 trace           | 1.0                | 0.2（用 `tracesSampler`，导航与 pageload 同值） | 配额；p95 由 metrics 提供，不依赖 trace |
| 后端 trace           | 1.0（`/health` 0） | 继承前端决定；无上游时 0.2；`/health` 仍 0      | 与前端一致                              |
| Replay 会话          | 1.0                | 0.05                                            | WebView 开销与配额                      |
| Replay 报错          | 1.0                | 1.0 不变                                        | 事件触发时回放缓冲                      |
| 卡顿/慢请求/报错事件 | 部分               | **全量**                                        | 偶发问题不能靠采样抓                    |
| Metrics              | 无                 | 全量（不受 trace 采样影响）                     | p95/p99 与比例                          |

待验证：`captureMessage` 是否触发 Replay 缓冲回放（预期会，因为属于错误类事件）；若不会，改用 `getReplay()?.flush()` 显式触发。采样值是初值，跑出配额占用后再调。

## 5. 后端设计

- `tracePropagationTargets`（前端）：`[/^https:\/\/stminiapp-(production|development)\.up\.railway\.app/]`，用环境变量里的 `NEXT_PUBLIC_API_URL` 推导，不硬编码。
- `onResponse` hook：`http.server.duration` distribution，attributes `route`（`request.routeOptions.url`）、`status_class`、`kind`（`sse` 对话生成接口单独 `kind=generation`，与普通接口分开）。
- Prisma：用 client extension 包一层 `db.client.operation.duration`（`model`、`operation`、`outcome`，超时错误码 `P2024` 记 `outcome=pool_timeout`），不改变现有调用点。Prisma 自带 metrics 是否可用（preview 特性）待验证，不依赖它。
- 事件循环延迟：`perf_hooks.monitorEventLoopDelay`，每 10 秒发 p99 gauge；进程 RSS gauge。
- 慢请求日志：`onResponse` 里 ≥ 3 秒的请求写 pino 一行（`{ route, status, durationMs, requestId }`），与 Railway 日志对照；不记录 body、token。
- `Timing-Allow-Origin`：对前端 origin 返回，让前端 `http.client` span 拿到 DNS/连接/首字节拆分。需验证 Sentry 的 `enableHTTPTimings`。
- 深度健康检查 `/health/deep`（R5，后期）：只做一次 `select 1`，带 2 秒超时，**不要**替换现有 `/health`（Railway 健康检查可能依赖它，改前需核实）。

## 6. 可靠性设计

| 项       | 设计                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 超时     | 客户端 20 秒（初值）；看门狗 4 秒；按钮 2.5 秒；`/health/deep` 2 秒                                                                 |
| 重试     | 监控上报不重试；Sentry SDK 自带队列。业务请求重试策略不变                                                                           |
| 降级     | 所有埋点包在 try/catch，失败静默（只 `log.warn`）；埋点自身不得影响业务路径                                                         |
| 防刷     | `slow_request`、`page_stall`、`action_stall` 各按 `route+类型` 每会话每分钟 1 条；fingerprint 固定为"类型+route"，Sentry 内合并     |
| 容量     | metrics 每请求 1 条；按现网日请求量估计在万级到十万级，先在 development 环境看用量再上生产                                          |
| 主线程   | 看门狗用单个 `setTimeout`，不轮询；in-flight 登记是 Map 增删；不在渲染路径里做同步重活                                              |
| 隐私     | 事件属性白名单：route 模板、耗时、outcome、requestId、tg 平台/版本、网络；不放 initData、token、聊天正文、响应 body、完整 URL query |
| 可观测性 | 埋点自身失败计数 `perf.instrument_error`，防止"监控静默失效"                                                                        |

## 7. 发布顺序与恢复

1. 先发后端（hook、metrics、采样）。只增不改，不影响前端。
2. 再发前端，先 `development` 环境验证（现有 `SENTRY_ENVIRONMENTS` 允许 `development`），确认事件、metrics、Replay 关联、无敏感字段，再上 production。
3. 采样降低与埋点同批上线，上线后 24 小时核对配额曲线。
4. 回滚：每期单独提交，revert 即可；采样值与阈值为常量，支持 forward-fix。
5. 停止条件：首屏 LCP/INP p75 较基线恶化超过 10%、Sentry 配额异常上涨、出现新的敏感字段泄漏，任一发生先回滚。

## 8. 看板与排查流程

看板（Sentry Dashboards）：

- 页面：`page.ready.duration` p75/p95/p99，按 route、tg_platform、net_type、coldStart 切分；`page_stall` 率。
- 接口：`api.request.duration` 与 `http.server.duration` p50/p95/p99，对话生成单独一栏；超时/5xx/断网率。
- 入场窗口：`page.entry_window` 的请求数与慢请求占比，按 coldStart。
- 稳定性：`asset.load_failed`、事件循环延迟 p99、`db.client.operation.duration` p95、池超时数。

排查流程（给运营/客服用）：用户反馈 → 在 Sentry Issues 按 `telegram_user_id:<id>` 搜 → 看该用户最近的 `page_stall`/`action_stall`/`slow_request` → 点 Replay 回放 → 点 trace 看后端耗时。

待验证：Sentry MCP 是否能创建 dashboard。不行就由负责人在 UI 里按上表建，或用 Sentry API token 脚本化，T6 处理。

## 9. 不在本期

连接池代码层优化与 15 秒 500 的来源（`research/pool-findings.md`，交工程）；飞书告警；可用性探测与定时任务心跳（P5）。
