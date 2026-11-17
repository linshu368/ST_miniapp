# Tasks

- [ ] T1 实现 provider 响应分类、evaluation 构建和异步状态机。
- [ ] T2 接入统一 generation forward，并保持响应体与业务语义不变。
- [ ] T3 放行 generation 域飞书 firing/recovered，回归支付抑制。
- [ ] T4 补充经风险评估确认必须的告警回归测试。
- [x] T5 实现 Venice `balances.usd` 阈值规则与 BalanceMonitor（超时、防抖、探针失败语义）。
- [x] T6 挂载到 `payment-alert-monitor` 轮次（支付 → 余额 → deliverOne）。
- [x] T7 更新运维文档并运行 typecheck、tests、complexity。
- [x] T8 审核是否需要将新事实同步到 backend module spec（余额监控在 payment-alert-monitor/generation alerting，不改 conversation-generation 模块契约；暂不扩写 module spec）。
