# 合并 dev 冲突处理与验证

日期：2026-11-11。合并目标为 `fix_request_speed`，本地HEAD为`3af25eeb`，待合入上游为 `f93117db36afadd13df057c3114d8912c4adaca6`。本次只处理正在进行的本地合并，不执行远端迁移、发布、推送或任务归档。

## 合并策略与结果

10个冲突文件已解决并标记。保留上游故事记忆/正文字数水位、回复反馈、生成调用与额度行为，同时保留本分支索引选页、独立展示投影、窄字段读取和CORS处理。

- `generation-stream.ts`、`surplus-call-transport.ts` 与上游版本逐字一致。
- Repository与mapping保持拆分结构，补充上游所需的升序`turns`及`ConversationContextMessage`，复用上游`turnsToMessages`。删除上游已退场的按轮窗口参数/helper，不恢复旧泄洪。
- 分支接口在拆分后的`conversation-interactions.ts`移除旧配置读取和retainTurns参数，沿用上游四参数RPC语义。
- app保留上游反馈路由注册及故事记忆worker启动/停止。
- 所有14个既有聊天接口的方法/路径与上游一致；反馈路由另外正常注册。
- UI回归保留上游紧凑回复操作和反馈场景，保留本分支SSE终态等待和200轮完整历史检查。
- 文档保留双方新增内容；复杂度预算沿用上游收紧值，移除本分支已拆分文件/函数的旧条目。原任务module-updates刷新为合并后的完整文档，避免将来覆盖上游说明。

## 验证

- 共享包：20文件、233项测试通过。
- 后端：143文件、1585项非真库测试通过。
- 前端：69文件、764项测试通过。
- 全仓`pnpm -r typecheck`通过。
- Admin生产构建通过；保留现有bundle体积提示。
- `pnpm lint:complexity`和`pnpm lint:migrations`通过；既有存量复杂度警告保留。
- 一次性本机PG17执行现有分支/编辑/点赞/反馈/展示投影回归通过，覆盖权限、完整游标、revision、并发、级联删除、投影失效及恢复。未启用性能基准，未连接Supabase。临时库清理成功，服务已停止。
- `pnpm test:ui --grep '@chat-history|@chat-like|@chat-dislike|@surplus'`：14项全通过（Android及320px窄屏，3.8分钟），测试原超时和重试设置未调整。包括无findLast的200轮完整翻页、草稿、分支、重答、取消、点赞失败恢复、点踩及反馈刷新幂等。
- 本次冲突处理路径的暂存差异空白检查通过；全量上游差异含`packages/shared/migrations/tests/story_memory.sql:243`文件末尾多空行警告。保留上游文件原样，未改其SQL行为。

## 构建限制与后续状态

Frontend生产构建未通过：既有`.next`目录无法移动，随后Next报告`webpack-build/impl`模块缺失。这与此前Windows standalone/junction缓存问题一致，但未将原因完全归结为某段业务代码。已按原锁文件强制恢复依赖，随后上述14项真实页面模拟回归通过；未再对占用中的普通构建目录重复操作，也未终止他人开发进程。生产构建仍须在可用的干净构建环境复核。

本次只标记冲突解决并暂存，不创建合并提交，不推送。`11-10`仍保持in_progress，原有性能/覆盖/发布缺口不因合并或功能测试通过而自动结项。`11-11`继续暂停，此前规划门禁不变，不增加固定样本实测要求。
