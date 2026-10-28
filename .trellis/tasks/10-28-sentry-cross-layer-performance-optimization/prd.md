# Sentry 全链路性能优化与稳定性治理

## Goal

基于 2026-10-28 Sentry、Railway 与 Supabase 生产证据，分阶段优化前端导航调度、戏剧首屏、生成交付、图片广场和可观测性；以验证门禁控制数据库与基础设施改动。

## Requirements

- 以 2026-10-27 15:00 至 2026-10-28 14:28（Asia/Shanghai）的 Sentry、Railway 与 Supabase 只读证据为基线，所有优化必须能回溯到明确的页面、接口或阶段指标。
- 优先降低首页、Chat、Characters、Dramas、Profile、Create 的用户可见 P95；不能用完整 SSE 生命周期替代首 token 或客户端可见时间。
- 前端导航必须区分一次性启动阶段与每次 SPA 导航阶段；离开页面后，可取消读取不得继续占用关键请求槽。
- 戏剧播放地址与首帧为关键路径；列表、社交、相邻内容预取和遥测不得阻塞首帧。
- 短剧范围覆盖 `/`、`/dramas`、`/dramas/[id]`；影像广场范围覆盖 `/create` 及其 feed、详情和媒体链路。两者必须分别排查网络瀑布、JS chunk、媒体下载/解码、React commit、请求排队、Storage 签名和 CDN 缓存，不能仅凭 API P95 判断页面性能。
- 大厅保护范围覆盖 `/characters` 角色大厅以及应用根 Providers/导航启动链路。短剧或影像广场路由之外不得自动拉取其 API、媒体、签名 URL 或业务 chunk，也不得让预取、遥测和后台刷新占用大厅关键请求槽、主线程或带宽。
- 预取必须感知路由与用户交互，并受 `saveData`、网络质量、页面可见性和 idle 状态约束；离开路由后取消可取消读取，禁止在全局启动阶段预取短剧或影像广场资源。
- 生成链路必须保留现有 10 秒首 token 总预算、hedged fallback、数据库 CAS、计费和额度语义；新版本未完成 24 小时观察前，不实施侵入式交付重构。
- 在 2026-10-29 对生产整体数据进行复盘并获得用户再次确认前，禁止修改 first-token、fallback/竞速、provider 路由、客户端 received/visible/committed 上报、计费资格、终态持久化以及相关数据库对象或 runtime config；期间只允许只读采集和整理现有指标。
- 图片广场减少重复配置读取、过宽投影和逐图签名；私有媒体边界不得为性能而放宽。
- Sentry、Railway 和 Pino 指标使用低基数字段，不记录 initData、token、消息正文、媒体 URL、支付数据或其他敏感内容。
- Railway CPU、内存、事件循环或连接数没有饱和证据时，不通过扩容掩盖客户端瀑布或外部供应商延迟。
- Supabase 索引、RPC、view 或表变更必须先取得 TEST/Production 对应 shape、`pg_stat_statements` 与受控 `EXPLAIN (ANALYZE, BUFFERS)` 证据；迁移只放在 `packages/shared/migrations/`，单文件人工执行。
- 若新增 Data API 对象，必须显式核对 exposed schema、grant、RLS、owner、`security_invoker`/`security definer` 边界；不依赖新对象自动暴露。
- 任务分批发布，每批可独立关闭或回滚；不得在同一批同时混入前端调度、供应商路由和数据库结构变化。

## Acceptance Criteria

- [ ] Sentry 丢弃量、采样和阶段指标可解释；生成链路分别展示 preparation、provider TTFT、server-ready、client-received、client-visible、stream-total 与 settle。
- [ ] 页面切换后 500ms 内，旧页面可取消读取不再占用队列；API Client 与 React Query 不再叠加重试。
- [ ] 首页导航 P95 小于 4 秒，戏剧首帧 P95 小于 3.5 秒；Drama 用户可见 telemetry 5xx/429 为 0，并可核对 accepted/dropped/persisted。
- [ ] 短剧和影像广场分别保留优化前后证据：请求瀑布、JS/媒体字节、LCP/首帧、长任务、React commit、队列等待和后端阶段；覆盖冷/热缓存、弱网、失败以及离开页面取消场景。
- [ ] `/characters` 冷启动和从短剧/影像广场返回时，不出现未触发的短剧/影像 API、媒体或业务 chunk；大厅请求数、传输字节、长任务和导航 P95 不回退，生产同口径回退超过 5% 即停止发布。
- [ ] Chat 新版本完成至少 24 小时生产观察；若继续实施生成优化，server-ready P95 小于 5.5 秒、ready-to-visible P95 小于 3 秒、client-visible P95 小于 8 秒、delivery failure 小于 0.5%。
- [ ] 2026-10-29 形成 first-token 整体复盘记录；只有用户明确批准继续后，相关任务才能解除冻结，未批准则保持现状并记录停止决定。
- [ ] 图片广场 feed 后端 P95 小于 1 秒，单页签名调用降为不超过一次批量调用，Create 页面导航 P95 小于 3 秒。
- [ ] Text postprocess version warm path P95 小于 300ms，miss/unavailable 语义不变。
- [ ] Railway 资源和 Supabase 连接指标不恶化；计费、额度、取消、409 并发保护和数据库终态无语义差异。
- [ ] 运行受影响包的 typecheck、现有相关测试、lint/build；跨包契约变化时运行 shared tests 与所有消费者 typecheck。
- [ ] 扩展 `packages/ui-tests` 现有 drama/chat/create/profile 场景，或在实现审核时记录为何现有 fixture 已充分覆盖；真实供应商、支付和系统键盘验收边界单独记录。
- [ ] 每个发布批次记录 release、观察窗口、停止条件、回滚/forward-fix 和上线后对照数据。

## Notes

- 生产基线来自 `D:/JobExe/ST/sentry/2026-10/2026-10-28  3点后至今.md`；该报告不是运行时配置来源。
- 本地工作分支与 Railway 生产 main 曾存在版本差异，实施前必须以最新 main 重新核对代码和生产 release。
- 本任务当前只完成规划；在规划人工审核并执行 `task.py start` 前，不写产品代码、不执行远程迁移或配置变更。
