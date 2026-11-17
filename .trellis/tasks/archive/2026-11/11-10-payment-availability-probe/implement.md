# 实施计划（已获用户批准，执行结果见 verification.md）

1. 确认默认渠道、合法 probe clientIp、TEST/production 凭据、1 元受理与商户风控；确认无需全链路验证或严格每窗一次。
2. 新增 payment 单轮探测/策略编排和短任务入口，复用网关、锁及后台观测；不进入充值用例，不新增依赖、数据库对象或公开契约。
3. 飞书策略复用 AlertPublisher；精确扩展新规则的投递过滤，验证旧消费者行为。
4. 配置独立 Railway Cron，参数集中解析；核验 IaC 已有重复变量，更新 README、架构、运维文档、相关 spec 与安全 example。
5. 风险评估：上游有真实建单副作用、多策略隔离和告警过滤需回归。用户批准规划后，已扩展既有网关/告警/锁测试，并为探测编排和脚本接线创建必要回归；所有外部依赖使用 mock。

## 可执行验证

- `pnpm --filter @miniapp/backend typecheck`
- `pnpm --filter @miniapp/backend test`
- `pnpm --filter @miniapp/shared test`
- `pnpm lint:complexity`、`pnpm lint:imports`、`git diff --check`
- 部署/跨包变动运行 `pnpm -r typecheck` 与根 package.json 定义的适用 build；Railway 先只读 plan，不自动 apply。

## 失败路径与消费者校验

- 业务失败、非法成功响应、HTTP 429/5xx、网络/超时：一次请求、不查回、无本地订单/事件/钱包写入。
- 单策略/多策略、某策略 throw/超时：其他策略执行，上游请求次数不增加。
- 持续失败去重、下一次成功恢复、未知/跳过不恢复；新 P1 可投递，旧规则抑制不变，卡片无敏感信息。
- DB 故障、通知关闭、飞书永久错误/重试耗尽、outbox 积压：区分已持久化与已送达，有限退出。
- 多实例、锁失败、SIGTERM、锁连接断开及清理失败：无补单，不占用原 monitor 锁。
- TEST 人工受控建单：确认上游 1 元待付，不访问链接；经已授权验收途径确认本地无订单/账务写入。Supabase MCP 不读取业务行。
- 启用前后各 24 小时对比真实用户建单 API P95、Android/iOS 充值页 P95、连接池与 429；样本不足延长观察，不用 mock 代替生产证据。

## 本地验收建议

将正常→异常→持续异常→恢复及多策略失败纳入现有网关/告警 mock 验收；无 UI 不新增临时浏览器脚本。未来若策略影响用户支付状态，扩展 packages/ui-tests 现有充值流程与真机支付回归。现有模拟验收不证明商户风控或飞书实际送达。
