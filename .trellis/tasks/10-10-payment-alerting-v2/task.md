# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                              | Files / Scope                                                 | Depends On        | Verification                                                      |
| --- | ------ | ------------------------------------------------- | ------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| T0  | Done   | 核验远端 shape/基线与数据库对象归属，确认发布门禁 | TEST/Production 只读结构、Railway 状态、`research/`           | -                 | 环境分别记录；对象归属/锁/容量/回滚审核                           |
| T1  | Done   | 统一确认 API 与 AlertEvaluation runtime 契约      | `packages/shared/src/api/`                                    | T0                | schema 边界、shared test、全部消费者 typecheck                    |
| T2  | Doing  | 支付与公共状态的兼容 migration                    | `packages/shared/migrations/`                                 | T0-T1             | lint:migrations；TEST 单文件前后 shape、RLS/grant、并发/RPC、旧行 |
| T3  | Todo   | Backend 支付采集与确认接口                        | payment route/usecases/gateway/repositories                   | T1-T2             | 既有 payment tests；重复/失败/四路/日志敏感检查                   |
| T4  | Todo   | Frontend 首次打开与重开意愿补记                   | recharge/VIP/order pages、`lib/payment`、`lib/api/payment.ts` | T1-T3             | typecheck、payment tests、lint/build、WebView 人工场景            |
| T5  | Todo   | 公共 Publisher、事故状态及 Feishu sink            | Backend 公共层、平台配置                                      | T1-T2             | 并发/重放/升级/恢复/429/超时/敏感样本，模拟日志 producer          |
| T6  | Todo   | 支付规则与独立监控任务                            | payment rules、monitor script、Railway config                 | T2-T5             | P0/P1 全矩阵、窗口/低量/heartbeat、`pnpm -r typecheck`、build     |
| T7  | Todo   | TEST shadow 与通知门禁验收                        | TEST DB、Preview、受控群                                      | T3-T6             | 事件完整率、P95 质量、真实受控支付、无敏感字段                    |
| T8  | Todo   | Production 分阶段启用与观察                       | 手工 migration、Railway、受控飞书群                           | T7 + 单独发布授权 | 单文件 postflight、服务 SHA、受控支付、3～5 天阈值复盘            |

## Execution Log

- 2026-10-10：从 `origin/dev` `5136b13b` 创建 `codex/payment-alerting-v2`；建立任务并保持 `planning`，等待规划审核。
- 2026-10-10：规划审核后切换为 `in_progress`。完成 T1：新增严格、版本化 `AlertEvaluation` 与收银台确认 DTO；`pnpm --filter @miniapp/shared test`（120 tests）、`pnpm --filter @miniapp/shared typecheck`、`pnpm -r typecheck` 与 `git diff --check` 通过。
- 2026-10-10：完成 T0 的账本与既有 probe 核验。TEST/Production 的 `Database Migration` inspect 分别为 run `38039126491` / `38039143061`，两者账本均无 drift；结构 probe 差异与限制记录在 `research/2026-10-10-environment-inspect.md`。Production 的支付快速对账 Worker 为 `RUNNING`，支付过期 Cron 已排程。新对象所需的完整 catalog/RLS/grant 尚未由 inspect workflow 覆盖，T0 保持 Doing；未执行 migration 或读取业务行。
- 2026-10-10：T2 新增 `20261010_payment_alerting_foundation.sql`。本地隔离 PostgreSQL 以最小既有 billing/app_core harness 完整执行 preflight/postflight；确认 RPC 首次调用 `recorded=true`、重复同一 request ID 为 `false`，订单计数与事件均保持 1。`pnpm lint:migrations`、`git diff --check` 通过。未执行 TEST/Production apply；TEST 单文件前后 shape、RLS/grant、并发/RPC 与旧行验证仍是完成门槛。
- 2026-10-10：补齐 Production 只读 catalog：三项确认列和三张新表均不存在；`payment_orders` 现有 RLS/历史 ACL、schema usage、索引，以及受保护结算 RPC 的 postgres owner/SECURITY DEFINER/安全 search_path/execute ACL 均与 migration 前提相符。未读取业务行、未执行 DDL；T0 完成。证据见 `research/2026-10-10-environment-inspect.md`。
