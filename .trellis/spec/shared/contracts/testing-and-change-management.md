# Shared 测试与变更管理

- schema 测试覆盖合法、非法、缺失、未知字段、默认值和向后兼容；纯函数覆盖边界、空值和确定性。
- 契约变更必须至少编译 producer 与全部实际 consumers；`pnpm -r typecheck` 是默认门禁。
- `api/telemetry.ts` 变更必须覆盖禁止键、`user_cohort` 不得出现、以及 `payment_return_observed.return_source` 的 `webview_resume`；frontend/backend 事件发送方不得私自加字段。
- bug 修复增加回归；类型-only 变更也要检查 runtime producer 是否真的返回该形状。
- 变更计划列公开出口增减、受影响包、部署顺序、旧数据/旧客户端、回滚和观察指标。
- 禁止用 `any`、双重断言或宽泛 index signature 掩盖契约不确定性；未知外部数据先 `unknown` 再解析。
- 高可用仅在契约层表达必要语义（幂等键、状态、错误码），重试/队列实现归所有者包；保持 shared 简洁和无 I/O。
