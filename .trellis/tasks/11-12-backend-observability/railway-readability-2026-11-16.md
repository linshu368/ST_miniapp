# Railway 中文摘要与场景可读性

## 需求与验收

用户提供的生产截图仅证明 Railway 当前展示 operation.started/terminal 和大量字段，未据此推断该环境的配置或完整版本。目标是首行能读出中文业务/技术模块、调用场景、真实结果、状态、耗时及可安全解释的错误；定时探测、预检和汇总不能丢失结果。保留 JSON、稳定英文事件/operation、全部开始/终态、等级、通知策略及链路查询，不新增存储或部署资源。

实际 Pino JSON 必须验证中文摘要、继承的 HTTP/任务场景、嵌套 child、已投影错误、敏感 message 拦截；余额预检覆盖通过/拒绝/跳过/查询异常；支付探测覆盖关闭/预览/配置错误/成功/不可用/策略部分失败/取消/租约竞争。既有测试文件扩展足够，不新增测试文件。

## 复用调研与最小方案

- 已检查 logger-options 的 logMethod、safe-log、events、core/runtime、context、http、job-core、SDK 导入测试及真实 logger JSON 回归。统一 hook 当前把说明覆盖成 event；不恢复未经审查的任意插值文本。
- 已检查 payment-availability-probe、availability round/probe/strategy；嵌套 probe/strategies 被白名单丢弃。仅在任务边界显式投影 kind/channel/errorClass、有限策略计数，不输出支付 URL、交易号或整个对象。
- 已检查 generation/precheck 及其测试：零扣费跳过只有 debug，余额通过无语义事件，查询抛错缺少本层明确预检结果；复用既有查询和 logger，不查询额外钱包数据。
- 同时检查 MiniappWalletRepository.precheckMainCredits（图片/语音共享）和 provider-balance-monitor-round：复用 observer 包装原媒体预检，保留原建钱包语义、查询与返回身份；余额监控补各供应商实际 ok/skipped/probe_failed 标量结果。扩展各自现有测试，不创建测试文件。
- 新增纯展示 factory 和项目中文词表，模块内集中维护；factory 可作为 SDK 展示适配接缝，默认应用选择中文词表。SDK 不引入项目词表、文件、环境、数据库或渠道。已有 shared contracts、前端 hooks、数据库函数无需变更，没有对外 DTO 变化。
- HTTP 仅把 method + 已注册 route 模板写成有界 call_scene，job 写已登记 job operation；跟随 ALS 子上下文传播。不能使用原始 URL、参数或请求正文。展示字段由安全机器字段生成，调用方伪造的中文展示字段和 msg 均丢弃。
- 错误摘要只使用识别的错误码、类型、HTTP/上游状态和固定分类词表，不输出未知 Error.message、SDK details、SQL 或凭据。未知错误明确标注未分类并保留 code/cause/源码位置，不能伪造具体原因。
- 不降级/采样成功日志，不另建 transport、配置服务、实时翻译、正则脱敏后放行任意消息或通用日志平台。

## 可靠性、演进与恢复

展示纯计算、有界长度/计数，不做 I/O；失败降级固定英文事件，不替换原结果或阻断日志。未知模块/事件保留安全英文代码。状态明确区分 HTTP 响应、上游响应、业务/探测和策略结果；HTTP 200 不能推断探测或业务成功。规则仍匹配原始稳定机器字段，默认关闭，现有通知并发/截止不变。

不修改超时、重试、幂等、并发控制、锁、事务、补偿和实际请求/计费；这些操作由原业务实现负责。日志只读既有结果，无数据库/历史数据迁移。单次增加摘要及上下文字段，发布后观察容量/CPU及 P95；无新增网络和持久状态。字段增量兼容消费者，原事件码可继续查询。先本地实际 JSON 回归，再随应用发布到目标环境；摘要错误、串号、泄密或 P95 劣化即停止发布并回滚本次展示改动。

Android/iOS 页面和 API 继续采用 task.json 真实无样本 null 基线及前后24小时分平台窗口；未采样不得填零，本轮不运行暂停的固定样本性能门禁。

## 实施与验证

用户明确要求本次不进行本地 UI 验证：不启动 UI、浏览器或截图验收；用真实 Pino JSON、既有测试、类型与静态检查验证，发布后再核对 Railway 实际展示。

1. 纯展示 factory/项目词表、统一 Pino hook、HTTP/job call_scene；扩展 logger/http/SDK 既有测试，含并发隔离、错误、未知事件、安全及不变更告警条件。
2. 显式投影支付探测结果/策略计数，补余额预检通过/跳过/拒绝/异常的真实语义；扩展现有 probe/precheck 测试，不发真实支付和通知。
3. 运行 Backend typecheck、相关及全量无凭证测试、ESLint、复杂度、日志 AST/规划门禁、规则校验；同步 README/运行说明/spec/模块知识载荷和验证记录，按完整模块 commit，不 push/部署。

命令：`pnpm --filter @miniapp/backend typecheck`；`pnpm --filter @miniapp/backend exec vitest run src/platform/observability src/scripts/payment-availability-probe.test.ts src/features/generation/precheck.test.ts --maxWorkers=2`；`pnpm --filter @miniapp/backend exec vitest run --exclude '**/*.integration.test.ts' --maxWorkers=2 --testTimeout=15000`；`pnpm lint:backend-logging`；`pnpm lint:complexity`；`pnpm --filter @miniapp/backend logging:validate`。

发布后人工验收：在目标 Railway 按 trace 查一条 VIP 请求及 DB 子操作、一次支付探测成功/失败和定时任务汇总；确认中文首行、真实结果和英文过滤字段，检查无敏感正文。真实供应商/通知和生产 P95 仍未验收，不用本地截图代替。
