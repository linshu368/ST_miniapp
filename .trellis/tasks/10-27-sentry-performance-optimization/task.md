# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                       | Files / Scope                                      | Depends On   | Verification                                  |
| --- | ------ | ---------------------------------------------------------- | -------------------------------------------------- | ------------ | --------------------------------------------- |
| T1  | Done   | 读取 Sentry 报告、补采发布后样本并完成复用/故障模型调研    | 报告、既有性能任务、Backend/Frontend 热路径        | -            | 证据与非目标写入 PRD/design                   |
| T2  | Done   | 实现用户身份 bounded cache + single-flight，并收窄返回类型 | `backend/src/lib/user.ts`、需要完整行的少数 routes | T1、规划审核 | 5 项并发/失败/TTL/容量单测 + typecheck        |
| T3  | Done   | 实现 runtime-config single-flight，保持 strict/signal 隔离 | `backend/src/platform/runtime-config.ts`           | T1、规划审核 | 6 项单键/键集/失败/signal 单测                |
| T4  | Done   | 合并 payment plans 页面配置读取                            | payment domain + route                             | T3           | 3 项批量读取/fail-closed/fallback 测试        |
| T5  | Done   | 运行 Backend 全量验证和静态检查                            | Backend + 模块 spec                                | T2-T4        | 938 tests、typecheck、lint/legacy/format/diff |
| T6  | Todo   | 发布后 Sentry 同口径验收                                   | Production 只读监控                                | 独立发布授权 | release、窗口、ratio/p95/5xx/drops 记录       |

## Planning Gates

- [x] 复用调研：现有 user/runtime-config/payment/React Query/ranking 能力已列出，明确复用或不改原因。
- [x] 可靠性设计：timeout、重试、幂等、并发、事务、降级、容量、可观测性与恢复已逐项评估。
- [x] 最小充分方案：无新服务、依赖、公开 API、状态源或 migration；拒绝 Profile 聚合端点与完整用户行缓存。
- [x] 演进与恢复：Backend 单独发布、停止条件、应用回滚与 forward-fix 已定义。
- [x] 可验证性：失败路径、consumer 类型校验、人工场景和命令已列出。
- [x] 用户审核 PRD/design/implement/task，并授权 `task.py start`。

## Execution Log

- 2026-10-27：创建任务并完成规划。未修改产品代码。
- 2026-10-27：补采 15:00 后 Sentry 已接收 span：`runtime_config` 535（p95 123.9ms）、`users` 340（p95 69.7ms），当前时延健康但请求量仍可收敛；不以继续缩短 timeout 作为方案。
- 2026-10-27：用户确认开始执行，`task.py start` 将任务置为 `in_progress`。核对 Supabase 官方 changelog/docs 与锁定的 `supabase-js 2.107.0`；保留 SDK GET/HEAD 瞬时错误自动重试，不新增应用层重试。
- 2026-10-27：完成不可变用户身份 60s/5000 项 bounded cache + single-flight；invite bind、replay telemetry 因需要可变字段改走完整行读取。新增 `user.test.ts`。
- 2026-10-27：完成 runtime-config 单键/同键集在途合并；strict 与自定义 signal 保持独立，无 TTL/陈旧窗口。新增 `runtime-config.test.ts`。
- 2026-10-27：`/api/payment/plans` 从四条页面配置读取收敛为一次批量读取，再与 VIP 策略并行；订单仍独立读取权威套餐。新增 `rechargeRules.runtime.test.ts`。
- 2026-10-27：验证通过：Backend typecheck；105 files / 938 tests；Prettier；legacy guard；直接使用相同 ESLint 配置的 Backend import lint；`git diff --check`。仓库 `pnpm lint:imports` 自带 `--rule '{}'` 与当前 ESLint CLI 参数类型不兼容而退出，已用去掉该失效参数的等价命令通过。
- 2026-10-27：未连接或操作 test/production Supabase；项目要求先确认目标环境，且本任务无 migration。真实 API smoke 与发布后 Sentry T6 留待独立环境/发布授权。
- 2026-10-27：完成 production 只读上线前基线。15:00–16:36 当前 release 为 `88cd811b46c2e9421875a1e9182c5efc6b7ab0eb`，1050 个已接收 `http.server` 样本未发现 `internal_error`；`users` 690 次（p95 151.0ms）、`runtime_config` 1225 次（p95 114.5ms）。目标接口均为 ok，其中 payment plans p95 116.5ms、users settings 121.6ms、wallet balance 106.0ms、wallet checkin 186.8ms、VIP status 89.0ms、conversations list 499.2ms、detail 1310.4ms。
- 2026-10-27：前一日同时段存在 Supabase 故障：`users` internal_error 265 次（p95 5.01s），`runtime_config` internal_error 100 次（p95 30.00s），并带动 payment plans p95 25.45s/30.00s、conversation/settings 等约 5s 错误。今日改善发生在本次代码部署前，只能归因于故障恢复/流量差异，不能算优化收益。
- 2026-10-27：当前页面短窗口仍有高 p95：`/` pageload 21.54s（n=15）、chat navigation 15.94s（n=35）、profile navigation 5.98s（n=20）；样本均不足 100，不作最终结论。窗口内 accepted spans 4297，约 139206 因 `no_parent_span` 丢弃，接收占比约 3.0%，已在实施计划记录数据可信度风险和发布后停止线。
