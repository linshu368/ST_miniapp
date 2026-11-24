# G1–G5实施计划 v3（用户批准后的收敛范围）

2026-11-24用户在复核v2后明确要求：已明确故障点修复；不明确先补日志/Sentry记录用于判断，再补稳定性。这是对本地实现的后续批准，替代v2的“仅复核/等待实施批准”，不扩大生产、计费、迁移或Git权限。采用codex-inline，当前分支产品与dev一致，保留用户暂存文件，不自动创建提交。

## 最小改动与证据边界

- G1：初始化显式区分not_started/initializing/skipped/initialized/failed，不再把失败标成成功；禁止未证明清理安全的自动重试。失败仅一次安全诊断。原桥错误附SDK阶段、原生receiver是否存在、HTML ready/可见状态，不采launch参数。线上桥根因继续待核实。
- G2：在原ResizeObserver Errors上附视口、滚动/文档尺寸和弹层状态，不新建Error或全局过滤；封面observer将布局更新合并到下一帧、同值不setState、清理取消frame，作为明确边界的稳定性补强，不宣称已定位大厅循环。999行gallery不改，避免盲重构。
- G3：只将timedFetch明确由调用方signal取消的实际拒绝标记为取消；该路径不记api.request_failed，独立HTTP/网络/内部deadline仍失败。用WeakMap把同一错误的安全请求阶段附到原Sentry Errors，跨对象/无法关联明确unknown。继续抛错，不用过滤掩盖未处理拒绝。
- G4：先锁定空闲Worker error仍缓存、下一任务落入失效实例的失败测试，再局部销毁；当前generation的active/idle错误均失效，旧回调不能影响新实例；补messageerror原文降级。增加可选onFallback回调，仅上报已提交原文降级的固定reason，不带正文/消息ID；前端限流warning日志，回调异常不能改渲染。资源失败根因不冒充已修。
- G5：保留现有3秒及有限恢复/计费/SQL。复用HTTP/db原始错误终态，新增业务回执终态stage/identity_ms/rpc_ms、recorded与unknown分类及原request/trace。成功、未记录、身份失败、RPC失败均可区分；未知不假确认。日志隔离，失败仍抛同一原错误并由HTTP记录{err}，不重复captureException。
- 迁移7项renderer旧契约测试，保留安全/正文scope/choice/通用details覆盖并验证正文旧状态/记忆隐藏；不恢复退役入口。

## 复用与可靠性

复用现有Sentry beforeSend/client出口、safe telemetry、request-timing、Worker queue/generation、requestLogger及chatDiagnosticFields。新文件仅安全诊断小模块及回执诊断helper；不引依赖、状态持久化、HTTP/DB契约、通用队列或原生桥框架。诊断只内存、固定字段、WeakMap；错误不复制正文/身份/URL/query，日志按reason每分钟及文档上限节流。成功路径无新增网络请求，失败不改变业务结果；保留既有明确超时/重试/幂等/owner/容量/补偿，事务和迁移不涉及。

## 日志与双端性能

所有新日志均为固定事件/阶段/允许字段。SDK、布局、请求和Worker记录不当作用户失败分母；浏览器不冒充Backend证据。Backend identity_ms/rpc_ms仅非负有限耗时，通过真实Pino JSON验证白名单及request/trace；不传receipt/用户/会话/消息ID/正文/initData。保留既有Sentry原事件，不改采样/告警/Issue状态。已取消仅有同请求明确证据才免error Logs。

Android/iOS页面和API基线仍null，指标/目标/48–72h有效样本按design与meta分开；无实测不报达标。初始化不加同步重依赖，observer每帧最多一次并取消，日志只失败或终态且有界；不增加模型/计费/请求重试。性能回退>10%且>200ms、真实失败扩大停发；资金/身份/隐私/持久数据风险立即停止。回执预算不调整。

## 回归、审核与恢复

安全/取消/生命周期风险确认需要回归测试。优先扩展client.retry、request-timing、renderer、logger已有文件；允许新增一份SDK初始化与一份诊断脱敏/关联测试，防止原始错误/身份泄漏及初始化重入回归。适用frontend/backend/renderer/shared测试、全consumer typecheck、lint/build/复杂度；后续用户明确“不做UI本地测试”，覆盖原计划中的@startup/@roleplay/@chat/@creator本地执行要求，保留可重复场景但不启动UI服务或测试。失败路径、真实未覆盖场景全部记录。

各补丁可独立回退应用，保留receipt/用户内容/幂等，不改SQL或SDK storage。先观测和明确故障修复，再有边界稳定性补强，最后trellis-check及任务/repair-report v3。原窗口49条仍是部分快照，工程验收不当生产恢复。无自动Git暂存/提交/推送、配置/生产部署、真实计费或Issue关闭。
