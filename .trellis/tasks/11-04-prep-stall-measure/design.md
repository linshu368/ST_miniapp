# 设计

## 复用调研

复用 Fastify 生命周期、`lib/perf-metrics.ts` 注册入口、Pino logger、Sentry metrics、Supabase `global.fetch` 扩展点与既有 Vitest。Prisma 全操作计时已覆盖池等待，不加重复埋点。只新增一个小型诊断模块及其必要回归测试，不改超长生成编排或工程遥测核心。

## 最小方案

1. `registerPreparationDiagnostics(app)` 仅跟踪聊天 POST messages/regenerate；WeakMap 保存单请求阶段时钟。preHandler→handler 用路由级最后一个 preHandler 标记，不侵入 handler：通过 onRoute 向现有 preHandler 尾部追加计时钩子；它覆盖鉴权与前置校验，并明确不含 handler 内业务读取。onResponse/onError/onRequestAbort 收口，慢/失败输出。
2. `observedSupabaseFetch` 原样调用 global fetch。安全资源名只保留固定格式的 REST 表/RPC 单段标识（拒绝 UUID），不保留查询、域名、header/body。1 秒待响应头事件帮助捕获尚未结束请求；finally 清理计时器，失败原样抛。Response 原样返回，正文不消费、不克隆；不覆盖现有 SDK 超时和重试。
3. Pino 记录允许字段；Sentry distribution 使用同样有界标签。新诊断暂不新增 Grafana 时间序列，Railway Pino 为不依赖导出可用性的排查入口。HTTP/RPC 名只作日志字段，不作指标标签；指标仅固定 stage、method、outcome。

## 可靠性

只观测，不重试、不新增外部请求、不改幂等/事务/计费/降级/限流。日志与 metrics 全部异常隔离。计时器单次 unref 并在 finally 清理，内存为在途请求量且由既有 30 秒 SDK 超时封顶。不可将等响应头耗时拆解为池等待或 SQL 耗时。全局 hook 不读取 body/header，不缓冲上传，不推断容器入口以前的网络时间。

## 演进与恢复

无 schema、配置或契约变更，仅后端部署；可整提交回退。若日志量或接口延迟明显回归则停止发布/回退。历史事故仍未定根因，部署后捕获新样本，不用新埋点倒推旧事实。

## 验证与风险评估

由于接入公共 Supabase transport，必须新增回归测试：fetch 参数/Response/signal/异常恒等、慢/挂起/取消清理、脱敏与遥测失败不影响业务。Fastify 使用真实 inject 测试成功、鉴权拒绝、非法 JSON 和普通路由不产生诊断；模拟延迟使用假时钟/时钟 spy，不访问生产。双端无当前版本样本，任务 metadata 显式 null；目标首字 P95 不退化。提交/发布前展示文件清单并沿既有授权门禁执行。
