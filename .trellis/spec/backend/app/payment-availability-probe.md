# 支付上游建单探测约定

## 1. Scope / Trigger

独立短任务只测 TTZF 建单能力。修改探测、组合策略、开关、告警投递过滤或 Cron 配置时必须阅读本文件及 [维护说明](../../../../docs/payment-availability-probe.md)。不保存探测订单，不进入充值/结算/对账。

## 2. Signatures

- `pnpm --filter @miniapp/backend payment:probe` → `src/scripts/payment-availability-probe.ts`。
- `availability/probe.ts#probePaymentAvailability` 返回 available/unavailable，或 skipped/configuration_error；只携带安全摘要。
- `availability/strategy.ts#PaymentAvailabilityStrategy`：`id`、`timeoutMs`、`appliesTo(observation)`、`handle(observation, signal)`。
- `availability/strategies/index.ts#createPaymentAvailabilityStrategies` 为唯一组合入口，返回单/多策略数组。

## 3. Contracts

`PAYMENT_PROBE_ENABLED` 必须精确等于 true 才运行，与 PAYMENT_ENABLED 独立；`PAYMENT_PROBE_CHANNEL` 默认 alipay、也支持 wxpay。两个变量在 platform/config.ts 解析，不新增运营配置。pr-/preview 始终跳过。`clientip` 由 probe.ts 自动选择本机非回环 IPv4，无匹配时回退 127.0.0.1；不读取 IP 环境变量，不请求外部 IP 查询服务，不把容器地址当作公网出口证明。

固定 1.00 元、每轮一次、7 秒网关超时；独立 Cron 每 30 分钟，45 秒取消在途工作并预留清理时间，进程硬期限 60 秒，失败不自动重启。锁 key 731007 不与 monitor 共用；无新数据库对象。策略最多 8 个、并发 2、各自预算 1–25000ms；总预算内失败互不阻断，达到本轮取消期限时未开始的策略也记 cancelled，不承诺所有慢策略都获得完整的单策略预算。

默认飞书策略复用 AlertEvaluation/Publisher/outbox；指纹 `<environment>:payment:upstream-create-probe:<alipay|wxpay>` 精确允许 P1 与 recovered。持续失败去重，成功关闭事故；accepted 不等于已送达。

## 4. Validation & Error Matrix

- disabled/preview → 数据库初始化前跳过；配置非法 → 不建单，不报告上游故障。
- 锁未取得 → skipped；锁/DB 异常 → 本轮失败，无建单重试。
- HTTP 200/业务失败、非法成功响应、429/5xx、超时/网络 → unavailable；仅网络/超时使用 suspected。
- SIGTERM/45 秒取消 → 不发布新的 healthy，不重发；未开始的策略记 cancelled，未知结果直接丢弃，60 秒硬退出兜底。
- strategy throw/timeout → 记录独立失败，其他策略继续；outbox 持久化失败不能算成功。
- 飞书失败 → 原有有限投递重试，不触发探测补单；原支付规则过滤保持。

## 5. Good / Base / Bad Cases

- Good：一笔临时 1 元建单→安全结果→策略；失败形成事故，后续成功恢复。
- Base：重复故障只更新事故；PR 即使复制开关也跳过；不保存时间槽，不能承诺严格每半小时一次。
- Bad：使用用户充值接口创建测试订单、暴露支付链接、增加全局 amount 参数、策略异常重新建单，或认为超时代表上游未受理。

## 6. Tests Required

回归自动选择本机 IPv4/无匹配时回环兜底、一次建单/无重试/响应脱敏、disabled/preview/configuration、单/多策略 throw/timeout/取消/重复 id、新 P1/恢复可投递且旧规则仍抑制、网关取消及锁释放异常仍关闭连接。运行 backend tests/typecheck、shared tests、部署相关全包 typecheck/build、复杂度/导入检查；真实 TEST 对自动 IP 的受理、建单、飞书送达与双端/用户建单 P95 在启用时人工核验。

## 7. Wrong vs Correct

Wrong：在 cron 中直接 fetch 飞书或把未来动作塞进探测函数。Correct：在 `availability/strategies/` 实现有超时/取消契约的策略并注册，飞书沿原有 outbox 投递。

Wrong：用进程 Map 假装跨实例去重、失败重发。Correct：独立 session advisory lock 仅防重叠，明确不保存时间槽、不承诺 exactly-once；任务失败不补单。
