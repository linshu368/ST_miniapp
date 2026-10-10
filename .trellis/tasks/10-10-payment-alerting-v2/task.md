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
| T2  | Done   | 支付与公共状态的兼容 migration                    | `packages/shared/migrations/`                                 | T0-T1             | lint:migrations；TEST 单文件前后 shape、RLS/grant、并发/RPC、旧行 |
| T3  | Done   | Backend 支付采集与确认接口                        | payment route/usecases/gateway/repositories                   | T1-T2             | 既有 payment tests；重复/失败/四路/日志敏感检查                   |
| T4  | Done   | Frontend 首次打开与重开意愿补记                   | recharge/VIP/order pages、`lib/payment`、`lib/api/payment.ts` | T1-T3             | typecheck、payment tests、lint/build、WebView 人工场景            |
| T5  | Done   | 公共 Publisher、事故状态及 Feishu sink            | Backend 公共层、平台配置                                      | T1-T2             | 并发/重放/升级/恢复/429/超时/敏感样本，模拟日志 producer          |
| T6  | Done   | 支付规则与独立监控任务                            | payment rules、monitor script、Railway config                 | T2-T5             | P0/P1 全矩阵、窗口/低量/heartbeat、`pnpm -r typecheck`、build     |
| T7  | Doing  | TEST shadow 与通知门禁验收                        | TEST DB、Preview、受控群                                      | T3-T6             | 事件完整率、P95 质量、真实受控支付、无敏感字段                    |
| T8  | Todo   | Production 分阶段启用与观察                       | 手工 migration、Railway、受控飞书群                           | T7 + 单独发布授权 | 单文件 postflight、服务 SHA、受控支付、3～5 天阈值复盘            |

## Execution Log

- 2026-10-10：从 `origin/dev` `5136b13b` 创建 `codex/payment-alerting-v2`；建立任务并保持 `planning`，等待规划审核。
- 2026-10-10：规划审核后切换为 `in_progress`。完成 T1：新增严格、版本化 `AlertEvaluation` 与收银台确认 DTO；`pnpm --filter @miniapp/shared test`（120 tests）、`pnpm --filter @miniapp/shared typecheck`、`pnpm -r typecheck` 与 `git diff --check` 通过。
- 2026-10-10：完成 T0 的账本与既有 probe 核验。TEST/Production 的 `Database Migration` inspect 分别为 run `38039126491` / `38039143061`，两者账本均无 drift；结构 probe 差异与限制记录在 `research/2026-10-10-environment-inspect.md`。Production 的支付快速对账 Worker 为 `RUNNING`，支付过期 Cron 已排程。新对象所需的完整 catalog/RLS/grant 尚未由 inspect workflow 覆盖，T0 保持 Doing；未执行 migration 或读取业务行。
- 2026-10-10：T2 新增 `20261010_payment_alerting_foundation.sql`。本地隔离 PostgreSQL 以最小既有 billing/app_core harness 完整执行 preflight/postflight；确认 RPC 首次调用 `recorded=true`、重复同一 request ID 为 `false`，订单计数与事件均保持 1。`pnpm lint:migrations`、`git diff --check` 通过。未执行 TEST/Production apply；TEST 单文件前后 shape、RLS/grant、并发/RPC 与旧行验证仍是完成门槛。
- 2026-10-10：补齐 Production 只读 catalog：三项确认列和三张新表均不存在；`payment_orders` 现有 RLS/历史 ACL、schema usage、索引，以及受保护结算 RPC 的 postgres owner/SECURITY DEFINER/安全 search_path/execute ACL 均与 migration 前提相符。未读取业务行、未执行 DDL；T0 完成。证据见 `research/2026-10-10-environment-inspect.md`。
- 2026-10-10：T2 在 TEST 完成单文件 apply：`20261010_payment_alerting_foundation.sql`（run `38042781412`，head `a6f98202`）成功并记账。catalog postflight 确认三列、三表、索引、RLS、仅 postgres/service_role 表授权、确认 RPC 的 postgres owner/SECURITY DEFINER/安全 search_path，以及 anon/authenticated 拒绝。Advisor 发现新建 outbox 的 incident FK 无覆盖索引，按 forward-fix 新增 `20261010_alert_delivery_attempts_incident_index.sql`（run `38043012878`，head `240ad5a0`）并成功记账；索引定义为 `(incident_id)`。在单一显式 ROLLBACK 的 TEST 夹具事务中，随机假用户/订单的首确认与同 request ID 重放验证为一条事件、订单计数 1，未读取真实业务行、未留下测试数据。T2 完成；未执行 Production migration。
- 2026-10-10：T3 完成：Backend 新增已鉴权、ownership 校验的收银台确认接口及服务端发生时间边界，调用 `billing.record_checkout_confirmation`；建单、网关建单、webhook、return、用户查单、快速/过期对账和结算均接入旁路操作事件采集。采集失败只写安全 pino 错误，不阻断下单、查单、履约或对账；网关失败使用稳定低基数 `error_class`。新增确认重放、非本人、无效时间与旁路失败测试，并运行 Backend typecheck 和相关 payment tests。未执行 Production migration、部署或通知开关。
- 2026-10-10：T5 在独立 `codex/payment-alerting-t5-publisher` worktree 完成。公共 Publisher 仅接收 shared `AlertEvaluation` 并返回 `accepted|duplicate|failed`；同一 Prisma transaction 以内按 fingerprint 锁定事故状态并原子写入 Feishu outbox，HTTP 始终在事务外。实现窗口/观测时间防回退、P1→P0 升级、恢复、通知幂等键、有限退避、429 Retry-After、超时、进程内最小限流和安全卡片拒绝；支付域未引入 Feishu/client/card/retry 代码。新增模拟 logs producer 测试。`pnpm --filter @miniapp/backend test`（75 files / 614 tests）、backend/shared typecheck、`git diff --check` 通过。TEST 与 Production 通知均未启用：runtime_config 缺失或非法时默认关闭，未写入任何环境配置或 webhook。
- 2026-10-10：T6 在 `codex/payment-alerting-t6-monitor` 自 `73d4bcdf` 开始；T4 状态按该基线已包含的收银台确认接线与其已记录验证更正为 Done。复用支付域的 15 分钟尝试段语义；监控只读、有界扫描，数据库查询失败不发布 healthy。未执行 Railway plan/apply、部署、迁移、TEST/Production 写入或通知开关。
- 2026-10-10：汇合 `origin/codex/payment-alerting-v2` 至 `6b24ad47` 后复验 T6：`pnpm --filter @miniapp/backend test` 通过（80 files / 629 tests），`pnpm -r typecheck` 通过，`git diff --check` 通过。Backend 没有独立 `build` script；Frontend `next build` 在本机超过两次 30 秒采样窗口仍未结束，未将其记为通过。T6 标记 Done；未提交本次任务记录更新。
- 2026-10-10：开始 T7 运行面核验。Railway development/TEST 的 `stminiapp` 仍为 commit `b3bc63ceac8b2b8c3ce130be3a51b00daaa4d0a4`，当前没有 `stminiapp-payment-alert-monitor` 服务；`codex/payment-alerting-v2` 没有 GitHub PR/Preview。`alerting` runtime config 缺失或非法时通知保持 fail-closed。尚无可供 shadow 的同版本 API/Worker，故 T7 Blocked；未写 TEST DB、未应用 Railway IaC、未创建 Preview、未启用 Feishu 或 Production。
- 2026-10-10：PR #383、#384 合入 `dev` 后，development IaC plan 复核为仅新增 `stminiapp-payment-alert-monitor`（1 add / 0 change / 0 destroy），随后 apply 成功创建服务 `f028378f-28fe-4f6d-8284-f5a6796a1f79`。首个 deployment `c72eeaf8-d80d-42b2-8a21-361ce0af4d3c` 成功运行；日志出现 `payment.alert_monitor.heartbeat`，`scannedRules=0`、`published=0`。通知仍由缺失/非法 `alerting` runtime config fail-closed，未配置 Feishu、未启用通知或 Production。T7 转为 Doing，等待真实 TEST 受控支付验证。
- 2026-10-10：TEST 受控支付完成且仅以 Railway 运行日志核验（不读取业务行）：已付样本记录 `initial_open` 后约 57 秒由 `query` 发现已付款并完成 VIP 履约；两笔未付样本均记录 `initial_open`，其中第二笔随后记录 `reopen` 且 `confirmationCount=2`。未见 `payment.operation_event.record_failed`。监控五分钟轮次计算了 11 条 P0/P1 规则（含 P1-05），`published=0`，通知保持关闭；当前低样本不足以用真实流量验证 P95 阈值触发，待受控群通知门禁与更多合格完成样本后再评估完成。
- 2026-10-10：核实第一次受控通知未入群的原因。development 监控在 `2026-10-10T13:37:36Z` 对 `development:alerting:notification-acceptance:all:firing:d58af3f0-d9a5-4c65-b790-d0e975a084f8` 记录了 `alert.delivery.sent`。同一请求形状重放飞书得到 HTTP 200、`code=11246`（卡片 JSON 无法解析）。原因成立：当时只把 HTTP 200 当成成功，且发出的是内部信封而不是飞书卡片。`a872655c` 已推到 `dev`，TEST 监控部署成功。修复后只在飞书 `code=0` 时记成功，并发送 interactive 卡片。新的受控 P1 `development:alerting:notification-acceptance-v2:all:firing:85c3c732-1254-4780-85f6-2e7a701af1d9` 一次投递为 `succeeded`，日志 `alert.delivery.sent` 时间为 `2026-10-10T15:17:33Z`；通知开关已回到关闭。未改 Production。第一次误记成功的记录未重发。
