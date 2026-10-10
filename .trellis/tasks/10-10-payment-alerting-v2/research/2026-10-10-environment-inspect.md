# 2026-10-10 环境只读核验

## 证据

- TEST：GitHub Actions `Database Migration` inspect run `38039126491`（2026-10-10 UTC），目标 project ref `zoqelpfhurwehlvypryl`。
- Production：GitHub Actions `Database Migration` inspect run `38039143061`（2026-10-10 UTC），目标 project ref `wbtsfzozlmurljvglhpn`。
- 两个 run 均成功；均为 workflow `mode=inspect`，只读迁移账本与既有 object probe，未执行 migration 或读取业务行。

## 结果

| 环境       | 迁移账本                            | drift | 结构 probe                                                                                                   |
| ---------- | ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| TEST       | 45 dated migrations，13 not applied | 0     | `ledger=yes`、`r3_grant_bonus_credits=yes`、`st_handle_column=missing`、`a_snapshot=yes`、`a_settled_at=yes` |
| Production | 45 dated migrations，13 not applied | 0     | `ledger=yes`、`r3_grant_bonus_credits=yes`、`st_handle_nullable=yes`、`a_snapshot=yes`、`a_settled_at=yes`   |

## 结论与限制

- 两环境的账本均无 checksum drift；现有支付/VIP 前置并非仅源码假设。
- TEST 与 Production 的 `st_handle` probe 不同，因此两者不能被视为同构；本任务不依赖该列，不据此改动既有对象。
- 该 inspect workflow 的 probe 未覆盖 `billing.payment_orders` 新增确认列、支付操作事件表或 `app_core` 告警表的具体 shape/RLS/grant。它不能替代新 migration 的 TEST 单文件前后验证。
- 远端核验发生在默认分支 `main` 的 workflow checkout；待本分支新 migration 合入可运行分支后，应在包含该文件的 head 上按单文件 TEST apply/postflight，再单独评估 Production。

## TEST catalog 补充采集（Supabase MCP，只读）

- 目标：`zoqelpfhurwehlvypryl`（testdb）；采集仅访问 `pg_catalog`、`information_schema` 和 Supabase 表元数据，不读取业务行。
- `billing.payment_orders`：已启用 RLS；现有列包含 `id`、`user_id UUID`、状态/金额/履约、`created_at`、`expires_at`、`paid_at`、快速对账列、`settled_by` 和 VIP 商品快照；**不存在** `checkout_confirmed_at`、`last_checkout_confirmed_at`、`checkout_confirm_count`。
- 目标新表 `billing.payment_operation_events`、`app_core.alert_incidents`、`app_core.alert_delivery_attempts` 均不存在。
- 订单现有索引：主键 `id`、`status`、`user_id + created_at DESC`、部分 `paid_at DESC`、部分 `next_reconcile_at` 及 `product_type + created_at DESC`；告警 migration 不能假设另有确认/事件时间索引。
- `billing.payment_orders` 对 `anon`/`authenticated`/`service_role` 都有表级 DML grant，但 RLS policy 为空。新增表保持 RLS 并只赋予 `postgres`/`service_role`，不得复制该历史宽授权。
- `billing.complete_payment_order(text,text,text)`：owner `postgres`、`SECURITY DEFINER`、`search_path=pg_catalog`，仅 `postgres`/`service_role` 有 EXECUTE；不得改变。`billing.expire_payment_orders(uuid)` 当前有更宽 EXECUTE，超出本任务范围。

## Production catalog 补充采集（Supabase MCP，只读）

- 目标：`wbtsfzozlmurljvglhpn`（Production），2026-10-10。本次只访问 `pg_catalog`、`information_schema` 与权限函数；不读取业务行。
- `billing.payment_orders` 仍不存在三项待新增确认列；现有索引为主键、`status`、`user_id + created_at DESC`、部分 `paid_at DESC`、部分 `next_reconcile_at`、`product_type + created_at DESC` 与 cohort 已付订单索引。迁移新增的确认时间部分索引不会与现有索引重名。
- `billing.payment_operation_events`、`app_core.alert_incidents`、`app_core.alert_delivery_attempts` 均不存在；`billing.payment_orders` 已启用 RLS、无 policy，且历史 `anon`/`authenticated`/`service_role` 表级 DML grant 均存在。新表继续采用仅 `postgres`/`service_role` 的授权，不能复制历史 ACL。
- `billing` 与 `app_core` 均向 `service_role` 提供 schema `USAGE`；`billing.complete_payment_order(text,text,text)` 仍为 `postgres` owner、`SECURITY DEFINER`、`search_path=pg_catalog`，仅 `postgres`/`service_role` 可执行。迁移 preflight/postflight 的环境前提成立。

## T0 收尾结论

- TEST 与 Production 已分别记录 migration ledger、对象前置 shape、RLS/grant、受保护结算 RPC、对象归属、锁/容量与 forward-fix 边界。
- 以上为 migration 编写前的只读基线，不替代 T2 的 TEST 单文件 apply/postflight，也不授权 Production apply。

## TEST migration postflight

- `20261010_payment_alerting_foundation.sql`：GitHub Actions `Database Migration` run `38042781412` 在 TEST 成功执行，head `a6f98202`。账本记录 checksum `dfd8e072462eaddce6a134b362a8d68133c0856d318101a242797e4f9086ef9f`。
- 仅 catalog/权限 postflight：三项确认列类型、默认值和 nullable 形状符合预期；三张新表已启用 RLS、无 policy，仅 `postgres`/`service_role` 有表 DML；确认 RPC 为 `postgres` owner、`SECURITY DEFINER`、`search_path=pg_catalog`，且 `anon`/`authenticated` 无 EXECUTE。两 schema 均向 `service_role` 提供 `USAGE`。
- Advisor 提示 `alert_delivery_attempts.incident_id` 外键缺少覆盖索引；这是本次新增对象的有效性能缺口，未忽略。
- `20261010_alert_delivery_attempts_incident_index.sql`：作为 forward-fix 在 TEST run `38043012878`、head `240ad5a0` 成功执行并记账。`app_core.idx_alert_delivery_attempts_incident_id` 定义为 `btree (incident_id)`；不改写已记账的 foundation migration。
- 受控行为验证在显式 `BEGIN … ROLLBACK` 中完成：仅插入随机假用户与 pending 假订单，首个确认记录成功，使用同一 request ID 的重放不再记录；事务内订单确认计数和事件数均为 1，随后回滚。未读取真实业务行、未留下测试数据。
- TEST 结果不代表 Production 已执行或已启用通知；Production 仍需 T7/T8 的独立发布授权。
