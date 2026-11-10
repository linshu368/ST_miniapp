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
