# 调研记录

- 已读取根README、ARCHITECTURE、workflow、frontend/backend/shared spec索引、相关模块、cross-layer guide、ui-tests README及Trellis brainstorm/before-dev。
- 使用Supabase技能与官方JavaScript abortSignal文档：https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal 。abortSignal控制fetch，不证明服务器SQL立即中止。
- 审计：../11-10-characters-chat-root-cause/report.md；../11-10-seven-day-page-performance/report.md。两目录既有未跟踪文件不得混入产品提交。
- 当前源码仍有ChatGuide.findLast、global-error reset、Android目录1800ms且在withRequestSlot后起钟、身份仅SDK和query fallback。
- 原历史读取已经history->0/1窄投影，不以重复实施投影声称性能优化。原route已经有阶段慢日志，但仅成功时有完整读阶段结果。
- getConversation GET包括陈旧streaming回收，不能对整个handler套重试。只重试listMessages SELECT闭包。
- 较长文件：page-tracker508、lobby-recommendations474、characters305、conversations-client351、backend-route878、HistoryRepository1006。避免向旧长文件追加编排，触及时抽取后收紧基线。
- PagePerfTracker静态依赖drama-observer；它有原生document/click早期观测，不允许简单延后安装丢起点。首屏拆分需保留轻量捕获或原入口，否则该项不落地。
- 未找到该前端项目的Vercel连接访问，不基于猜测改资源保留策略或升级框架。
- 用户已请求修复并提供AGENTS要求使用任务；本次任务创建在授权范围内。复杂规划必须经最终摘要后的用户确认再进入实现，见workflow Phase1.5和trellis-brainstorm Non-Negotiable Planning Contract。
- 2026-11-10用户追加OPTIONS 500归因及纳入规划，新增R8/AC9-12/B2。已确认app.ts普通Error拒绝Origin -> Fastify默认500；历史拒绝主要为Vercel域名与HeadlessChrome。方案纠正403分类和日志/访问目标，不放宽生产来源。详见cors-preflight.md。
- 后续用户明确固定Vercel域名就是正式入口；生产实测该Origin500而app.themijing.com为204，原窗口固定正式域名有62条拒绝。修正“Vercel=Preview”错误推断：先修正式域名精确放行/规范化，再处理真正未授权来源403。FRONTEND_URL还用于支付回跳，增加可选精确Origin列表兼容两个已有入口；未经授权不修改生产配置，具体记录见formal-origin-probe.json。
