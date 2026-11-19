# 数据库重组阶段 4：任务表、支付对账、支付事件迁 ops

父任务：`.trellis/tasks/11-17-db-reorg`。规则见 `docs/db/CONTRACT.md`，落位见 `docs/db/registry.yaml`。

## 目标

1. 实体表里的租约/重试/对账调度列挪到 `*_jobs` 旁表（参照 `experience.story_memory_jobs`）。
2. 修支付对账没有退避、对同一批未付订单每 30 秒查一次单、连查 7 天的问题。
3. `billing.payment_operation_events`（观测 O）整表迁 `ops.payment_events`。

## 约束

- 碰钱已授权直接做（11-17），核对不能省：入账只走 `PaymentSettlement.settlePaidOrder`，迁移不改订单状态与钱包。
- 扩展 → 后端发布 → pg_stat_statements 确认旧读写停涨 → 收缩。
- 不读业务行；只看结构与聚合。

## 验收

- 生产对账查单量从每天约 3 万次降到数百次，且已付订单仍能在退避窗口内被对账补账；
- 支付告警（PaymentAlertMonitor）照常从新表读；
- `payment_orders` 只留订单与履约事实；`payment_operation_events` 在 ops。
