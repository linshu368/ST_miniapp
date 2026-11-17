# Sentry / Grafana 全链路与耗时口径审计

审计日期：2026-11-05  
审计范围：当前仓库代码、部署示例、Grafana dashboard/runbook、既有测试，以及可用的只读 Sentry API。  
结论边界：本报告能确认“代码是否具备埋点”和“计时口径是什么”，不能仅凭仓库确认生产环境变量、Collector、数据源、migration/job 是否已经实际启用。

## 1. 结论摘要

1. MiniApp 浏览器端与 Fastify 主服务已经接入 Sentry；Fastify 所有非 `/health` route 也有统一的 Sentry/Grafana 请求时长入口。覆盖最完整的是聊天生成与短剧播放。
2. Grafana 代码通路并不等于生产已接入：浏览器端必须显式设置 `NEXT_PUBLIC_GRAFANA_*`，后端必须显式设置 `ENGINEERING_TELEMETRY_ENABLED=true` 和 OTLP endpoint；当前 production env 示例没有浏览器 Grafana 配置，后端开关为空。仓库也明确不负责创建/启用 Railway Alloy 与 Grafana Cloud。因此生产是否真正有数据必须在线核对。
3. 确认完全或实质未接入的高价值链路包括：Admin SPA、6 个新增 MiniApp 页面、Next.js `lobby-characters` 中转 handler、独立 payment alert/支付定时脚本及其他 standalone scripts。后台常驻 job 虽运行在已初始化 Sentry 的 Fastify 进程里，但大量异常被捕获后只写 Pino；当前 Alloy 又不抓 stdout，因此仍是部分盲区。
4. 最重要的耗时口径错误是前端 Sentry `api.request.duration`：它只统计到响应头到达，响应体读取、JSON 解析和校验不在内，20 秒 timeout 也在响应头后解除。慢 body 会从 Sentry 请求耗时、inflight 和超时保护中消失。
5. 聊天旧 Sentry `chat.full_reply.duration` 在 SSE `done`、最后一批文字已经提交后，仍等待 conversation detail 回拉完成才结束，确认会高估“用户看到完整回复”的时间。
6. 聊天 SSE 主链本身没有“收到 done 后还等待 EOF”问题：浏览器收到 `done` 后立即结束 parser 并 cancel body；服务端发送终态后立即 close。服务端另有 `sse.stream.duration` 统计整段连接，这是生成/连接诊断值，不应解释为用户可见完成时间。

## 2. 覆盖矩阵

状态定义：完整 = 有错误、总耗时和关键阶段；部分 = 只有通用 route/采样 trace/日志之一；无 = 该运行入口没有初始化或显式上报；待核对 = 代码具备，但生产启用状态未知。

| 链路                                                                      | Sentry                                                                     | Grafana                                                         | 结论                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| MiniApp 启动、21 个已登记页面                                             | 客户端错误、startup/page metrics；BrowserTracing 延迟到首屏后加载          | Faro 自定义 startup/page 指标，需生产开关                       | 部分/待核对；页面口径见第 4 节                           |
| `/creation/characters/new`                                                | 只有全局错误/可能的延迟 tracing，无 `page.ready`                           | 无独立 page ready/stall                                         | **未接入页面性能**                                       |
| `/creation/characters/:id/edit`                                           | 同上                                                                       | 同上                                                            | **未接入页面性能**                                       |
| `/creation/data`                                                          | 同上                                                                       | 同上                                                            | **未接入页面性能**                                       |
| `/creators/:id`                                                           | 同上                                                                       | 同上                                                            | **未接入页面性能**                                       |
| `/wishes`、`/wishes/:id`                                                  | 同上                                                                       | 同上                                                            | **未接入页面性能**                                       |
| Admin SPA                                                                 | 没有 SDK、初始化、页面/接口埋点                                            | 没有 Faro/OTLP/自定义埋点                                       | **完全未接入**                                           |
| 常规 MiniApp `apiClient` → Fastify                                        | 前端 headers-only metric；后端全 route 总时长、错误和采样 trace            | 前端 queue/headers/body/total；后端 route histogram，均依赖开关 | 部分；Sentry 客户端口径错误                              |
| Next `/api/lobby-characters` → Fastify                                    | 浏览器和后端两端可见，中间 Next handler 无 server instrumentation          | 中间 handler 无指标                                             | **中间跳盲区**                                           |
| 聊天 SSE                                                                  | 后端首个可见 token + 整段 stream；前端首 token 与旧 full reply             | LLM/preparation/TTFT、前端 terminal commit、后端 stream/route   | 较完整；full reply 语义混用                              |
| Creator polish NDJSON stream                                              | 原始 fetch，无客户端自定义 TTFT/full；后端只有通用 route/采样 trace        | 无客户端阶段；后端只有通用 route                                | **流式阶段未接入**                                       |
| LLM generation/provider                                                   | Sentry 采样 trace、错误与生成埋点                                          | generation attempt、preparation、TTFT、terminal 指标            | 当前最完整；仍须确认生产 exporter                        |
| 短剧列表/播放/CDN                                                         | 页面、API 及错误；采样 trace                                               | list/detail/first-frame/quality/seek/server stages              | 较完整；first-frame 结束条件正确                         |
| 支付下单/回调 HTTP                                                        | Fastify 通用 route + 采样 outbound span                                    | 通用 route total；无支付 provider 分阶段指标                    | 部分                                                     |
| 支付 expire/reconcile/callback-report/webhooks 脚本                       | 脚本未 preload Sentry                                                      | 无 exporter；stdout 不进当前 Alloy                              | **完全未接入运行入口**                                   |
| `stminiapp-payment-alert-monitor` 常驻服务                                | 独立脚本未 preload Sentry；捕获异常主要写日志                              | 无 exporter；stdout 不进当前 Alloy                              | **P0 完全未接入**                                        |
| 图片/语音生成 HTTP                                                        | 通用 route、采样 trace；部分图片可见指标                                   | 通用 route；LLM 共用阶段；缺少 voice/image 专属端到端阶段       | 部分                                                     |
| Chat image/history sync、lobby ranking、image plaza jobs                  | 继承进程初始化，但捕获错误多只写 Pino；image plaza 只有部分显式 Sentry log | 无 job duration/backlog/success/error 指标，Pino stdout 不采集  | **部分，失败可见性不足**                                 |
| VIP reminder、seed/translate、drama compare/report scripts                | standalone 入口未初始化                                                    | 无 exporter                                                     | **未接入**；部分是运维分析工具而非在线链路               |
| Support/Bot `/api/support/*` 代理                                         | ST 侧通用 route + 采样 outbound span                                       | ST 侧通用 route；无 upstream stage                              | 部分；独立客服仓库不在本次审计范围                       |
| Telegram、community、invite、growth、wallet、notification、creator/social | Fastify 通用 route、错误和采样 trace                                       | 通用 route total；多数无业务阶段指标                            | 部分，不是“完全未接入”                                   |
| Prisma DB                                                                 | 自动/显式 DB 测量                                                          | `st_db_operation_duration`                                      | 已接入，依赖 exporter                                    |
| Supabase/PostgREST/RPC                                                    | 仅采样的 outbound HTTP span                                                | 没有 DB/RPC 阶段指标，无 Tempo trace                            | **部分盲区**                                             |
| DB `grafana_core_recent_30m` cron                                         | Sentry 无                                                                  | 结果供 Grafana 读取，但 cron 本身无失败/耗时告警                | 部分；首次迁移还可能保持 disabled                        |
| DB `drama_metrics_cleanup_daily` cron                                     | Sentry 无                                                                  | 没有 job health 指标                                            | **默认 disabled，未接入 job health**                     |
| admin-cli                                                                 | 无 SDK                                                                     | 无指标                                                          | 未接入；这是运维 CLI，不属于页面 P95，但失败缺少集中观测 |
| shared/admin-client/reply-renderer                                        | 不应独立初始化，继承宿主                                                   | 不应独立初始化，继承宿主                                        | library 本身不是缺口；Admin 宿主缺失才是缺口             |
| ui-tests                                                                  | 不适用                                                                     | 不适用                                                          | 测试工具，排除生产可观测性范围                           |

## 3. 未接入与部分接入问题分级

### P0

1. **支付告警常驻服务与支付运维脚本无 Sentry/Grafana bootstrap。** `payment-alert-monitor.ts` 是 Railway 独立常驻服务；expire/reconcile/callback-report 等也是独立 `tsx` 入口，均不会执行 `server.ts` 顶部的 `instrumentation.ts`，也没有 OTLP 初始化。支付异常可能只存在 Railway stdout。
2. **前端 HTTP timeout 和 Sentry total 在 headers 时提前结束。** 这既会错报 P95，也会让响应体卡住失去 20 秒保护和 inflight/stall 诊断。建议把现有指标改名为 `api.headers.duration`，并由完整 body 解析后的统一 finally 上报真正的 `api.request.duration`；AbortController 必须覆盖 body 消费。
3. **生产 Grafana 全局启用状态未验证。** 若生产没有实际配置这些开关，则表中所有“代码已具备”的 Grafana 浏览器/后端指标都会整体缺失。上线核对应先于新增更多埋点。

### P1

1. Admin SPA 完全无 Sentry/Grafana。
2. 六个新增 MiniApp 页面没有注册到工程 page route，也不调用 `usePageReady`。
3. 聊天 Sentry `chat.full_reply.duration` 把 terminal detail refetch 算在用户可见完整回复之后。
4. Creator polish NDJSON 原始流没有 headers/首字符/done/close 的客户端指标；服务端也只有整个连接时长。
5. Next `/api/lobby-characters` 中转层没有 server-side Sentry/Grafana，出错时只能看到浏览器端失败和后端是否收到请求。
6. in-process jobs 的捕获异常大多只写 Pino，而当前 Alloy 配置明确不抓 stdout；缺少 job outcome、duration、backlog/lag。
7. Supabase/PostgREST/RPC 没有 Grafana 阶段耗时；Sentry 只能依赖 20% 采样的 outbound HTTP span。

### P2

1. `apiRouteGroup()` 的匹配顺序会把 `/api/characters/latest-badge`、`latest-seen`、`social`、`recommendation` 等静态路径误归为 `character_detail`；新增 `/api/creator/*`、`/api/character-wishes*`、creator analytics 等落入 `other`。这会污染或隐藏 Grafana API P95。
2. `page.ready.duration` 与 Grafana `page.launch` 起点不同：前者从 `PagePerfTracker` mount（Telegram ready 后）开始，后者 document visit 可从 0 开始。二者不能放在同一“页面总加载”口径直接比较。
3. `usePageReady` 在 React effect 后的 microtask 结束，不等待浏览器 paint；它表示“React 已 commit/业务状态 ready”，不严格等于用户已经看到像素。关键图片/首帧已有独立指标，普通页面 dashboard 标题也应明确这一点。
4. 聊天后端在 client disconnect 后按设计继续生成落库；`sse.stream.duration`/Grafana generation route total 因而可能包含用户离开后的工作，而且缺少 `client_gone` 维度。适合资源诊断，不适合 UX 完整回复 P95。
5. DB cron 只产出结果，没有独立的 last-success、duration、rows、error 指标。`grafana_core_recent_30m` 还会在首次无缓存数据时被置为 disabled，源码存在不能证明生产 active。

## 4. 页面耗时审计

### 4.1 已确认正确的点

- hidden/background 时间会从 page elapsed 中扣除；后台期间到达 ready 会延后处理，避免 Android/iOS Telegram WebView 切后台污染 P95。
- route change、failure 和 ready 都会清理 stall timer；错误页不会永久挂着正常 ready 计时。
- `/profile` 和 `/creation` 的主内容 ready 不等待 wallet/favorites 后台刷新，说明实现已经避免了“次要请求拖长首屏”。
- 角色、短剧列表把数据 ready 与 critical visual 分开，不要求所有图片下载完成才结束 page ready。
- 短剧播放必须同时有 `playing` 和帧证据才结束 first-frame，不会把仅收到 media event 当作用户已经看到画面。

### 4.2 问题与语义风险

| 指标                         | 当前起点                                        | 当前终点                           | 判断                                               |
| ---------------------------- | ----------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| Sentry `page.ready.duration` | Telegram ready 后 `PagePerfTracker.beginPage()` | `usePageReady` effect 后 microtask | 不是冷启动总时长，也不是严格 paint；名称容易被误读 |
| Grafana `page.launch`        | document visit 可从 performance 0               | 页面 content ready                 | 可覆盖启动/bootstrap；与 Sentry 不同口径           |
| `page.critical_visual`       | page/资源观察开始                               | 关键图像 load/decode 或首帧        | 对视觉完成更可靠                                   |
| 六个新增页面                 | 无                                              | 无                                 | 没有 page ready/stall/P95                          |

没有在已登记页面中确认到“为了角标、预取或动画结束而继续等待”的系统性错误；最接近用户描述的确定问题出现在聊天 full reply，而不是 page ready。页面指标的主要问题是覆盖缺失和“commit 不等于 paint”的命名/解释风险。

## 5. HTTP 与流式耗时审计

### 5.1 普通 HTTP

调用顺序是：`timedFetch()` 等待 `fetch()` resolve → 立即上报 Sentry 并清 timeout/inflight → `apiClientOnce()` 再执行 `response.json()` → Grafana attempt/body/total 在外层结束。

因此当前口径为：

- Sentry `api.request.duration` = request start → response headers；**不是总耗时**。
- Sentry slow request 和 page stall inflight 也只看到 headers。
- 客户端 timeout 只保护 headers；body stream/JSON parse 不受保护。
- Grafana `api.headers`、`api.body`、`api.total` 的拆分是正确方向，且 `api.total` 包括 retry；但生产是否启用待核对。
- Fastify `http.server.duration` / `st_http_server_duration` 对普通 JSON route 是接收请求到响应完成，口径正确。

### 5.2 聊天 SSE

实际顺序：

1. 服务端通过 SSE sink 写 headers；
2. 首个成功写出的非空 `delta/reasoning` 结束 Sentry `http.server.duration(response_milestone=first_visible_token)`；
3. 浏览器在匹配文本 React commit 后结束客户端 first-token observation；
4. 服务端发送 `done`，浏览器先 flush batch、调用 `onDone` 并退出读取循环，然后 cancel body；
5. 服务端紧接着 `sink.close()`；Fastify `onResponse` 上报 `sse.stream.duration` 和 Grafana route lifetime；
6. React hook 随后还会 `invalidateQueries(conversation detail)`，旧 Sentry `chat.full_reply.duration` 在这一步完成后才结束。

判断：

- “SSE 已经返回 done 但前端还等 EOF 才算完成”在当前 parser 中**不存在**。
- 服务端 first-visible-token 与整段 stream 已拆分，设计正确；本地 Fastify hijack 验证也确认 `onResponse` 会执行。
- 旧 Sentry `chat.full_reply.duration` **确认结束过晚**，包含 detail reconciliation。
- Grafana `roleplay.full_reply` 的定义是“匹配持久化终态消息 React commit”，故意等待 durable state；它适合作为一致性恢复指标，不应标成“最后文本已经可见”。
- 如需用户体验指标，应新增/调整为 `send click → done 对应最后一批文本 commit（最好在下一帧确认）`；detail refetch/durable takeover 单独保留 recovery/reconciliation 指标。

### 5.3 Creator polish NDJSON

浏览器直接 `fetch()` 读取 stream，绕过 `apiClient`。服务端 `reply.hijack()` 后只记录完成日志，通用 Fastify hook统计整个连接。缺少：headers、首字符、业务 done、客户端 render complete、abort/timeout outcome。它是当前第二条明显的流式盲区。

## 6. 生产核对限制

- 仓库历史配置指向 Sentry org `wangqiao`、project `st-miniapp`、region `de.sentry.io`。
- 环境中存在 Sentry token，但通过官方只读脚本查询 region endpoint 与默认 endpoint 都返回 HTTP 403 permission denied。因此本次无法确认 2026-11-05 当前生产 issue/event、环境、release 和性能样本是否可见。
- 需要为 token 提供对该 org/project 的 `org:read`、`project:read`、`event:read` 权限后，重新核对最近 24h/7d 的错误与事件。
- 当前 Sentry skill 的 API 只覆盖 issue/event 基础查询，不提供性能聚合；即使权限修复，页面/API P95 仍需在 Sentry Performance/Metrics UI 或相应官方 API 复核。
- 没有可用的 Grafana/Alloy只读连接，本报告不能确认 datasource、dashboard 实际有数据、生产环境变量、migration 和 cron active 状态。

## 7. 最小修复顺序

1. 先核对生产 Grafana 浏览器/后端开关、Alloy、datasource、release labels；修复 Sentry token 权限。若全局 exporter 没开，先恢复通路。
2. 修复 `timedFetch`：保留 headers metric，但把总耗时、inflight 与 timeout 移到 body 消费/校验完成；补 slow/chunked body 回归测试。
3. 拆分聊天完成口径：`last_text_committed` 与 `durable_terminal_committed`；旧 dashboard 明确迁移窗口，不能静默改语义。
4. 给六个页面补 route registry 与 `usePageReady`，并修正 `apiRouteGroup` 静态路径优先级及 creator/wishes 分组。
5. 接入 Admin、Next lobby proxy、creator polish stream；流式统一记录 headers/first data/business done/close，不能只加一个 total。
6. 为 payment alert/expire/reconcile 等 standalone 入口 preload Sentry 与工程 telemetry，增加 job run outcome/duration/lag；再扩展到 image/history/lobby/VIP jobs。
7. 为 Supabase/PostgREST 和关键 provider 增加低基数阶段计时；不要为了补 Grafana 一次性引入全局 trace 框架。

## 8. 验证记录

- Frontend 现有性能测试：6 个文件、130 个测试通过。
- Backend perf/engineering observability 测试：2 个文件、13 个测试通过。
- 本地 Fastify 5 最小验证：`reply.hijack()` + `raw.end()` 后 `onResponseCount=1`。
- 静态核对了 27 个 MiniApp page 文件、route registry、直接 `fetch()` 入口、Fastify 全局 hook、standalone scripts、in-process jobs、production env 示例、Grafana dashboards 和 DB cron migration。
- 本任务只新增审计文档，没有修改产品代码、仪表盘、环境变量或生产配置。

## 9. 关键证据索引

- 页面 registry：`packages/frontend/src/lib/perf/route-template.ts`
- 页面起止和 Sentry metric：`packages/frontend/src/lib/perf/page-tracker.ts`
- React ready 提交：`packages/frontend/src/lib/perf/page-ready.ts`
- Provider/延迟 tracing：`packages/frontend/src/app/providers.tsx`、`packages/frontend/src/instrumentation-client.ts`
- Sentry HTTP timing：`packages/frontend/src/lib/perf/request-timing.ts`
- body parse 与 Grafana total：`packages/frontend/src/lib/api/client.ts`、`packages/frontend/src/lib/perf/api-timing.ts`
- 聊天 parser：`packages/frontend/src/lib/api/conversation-stream.ts`
- 聊天旧 full reply：`packages/frontend/src/hooks/use-conversation-turn.ts`
- 后端 SSE/request metric：`packages/backend/src/lib/perf-metrics.ts`
- SSE sink：`packages/backend/src/features/conversations/sse.ts`
- Creator polish：`packages/frontend/src/lib/api/creator-characters.ts`、`packages/backend/src/routes/creator-tools.ts`
- Grafana 启用边界：`ops/observability/README.md`、`ops/env/backend.env.production.example`、`ops/env/vercel.env.production.example`
- Railway payment alert service：`ops/railway/README.md`
- DB cron：`packages/shared/migrations/20261026_grafana_light_core.sql`、`packages/shared/migrations/20261027_drama_playback_observability_forward_fix.sql`
