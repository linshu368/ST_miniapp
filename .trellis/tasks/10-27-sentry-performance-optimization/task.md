# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                       | Files / Scope                                      | Depends On   | Verification                                    |
| --- | ------ | ---------------------------------------------------------- | -------------------------------------------------- | ------------ | ----------------------------------------------- |
| T1  | Done   | 读取 Sentry 报告、补采发布后样本并完成复用/故障模型调研    | 报告、既有性能任务、Backend/Frontend 热路径        | -            | 证据与非目标写入 PRD/design                     |
| T2  | Todo   | 实现用户身份 bounded cache + single-flight，并收窄返回类型 | `backend/src/lib/user.ts`、需要完整行的少数 routes | T1、规划审核 | 并发/失败/TTL/容量单测 + typecheck              |
| T3  | Todo   | 实现 runtime-config single-flight，保持 strict/signal 隔离 | `backend/src/platform/runtime-config.ts`           | T1、规划审核 | 单键/键集/失败/signal 单测                      |
| T4  | Todo   | 合并 payment plans 页面配置读取                            | payment domain + route                             | T3           | 现有测试扩展、响应/fallback 对拍                |
| T5  | Todo   | 运行 Backend 全量验证和人工 smoke                          | Backend + 受影响页面                               | T2-T4        | typecheck/test/lint(如有)/diff-check + 场景记录 |
| T6  | Todo   | 发布后 Sentry 同口径验收                                   | Production 只读监控                                | 独立发布授权 | release、窗口、ratio/p95/5xx/drops 记录         |

## Planning Gates

- [x] 复用调研：现有 user/runtime-config/payment/React Query/ranking 能力已列出，明确复用或不改原因。
- [x] 可靠性设计：timeout、重试、幂等、并发、事务、降级、容量、可观测性与恢复已逐项评估。
- [x] 最小充分方案：无新服务、依赖、公开 API、状态源或 migration；拒绝 Profile 聚合端点与完整用户行缓存。
- [x] 演进与恢复：Backend 单独发布、停止条件、应用回滚与 forward-fix 已定义。
- [x] 可验证性：失败路径、consumer 类型校验、人工场景和命令已列出。
- [ ] 用户审核 PRD/design/implement/task，并授权 `task.py start`。

## Execution Log

- 2026-10-27：创建任务并完成规划。未修改产品代码。
- 2026-10-27：补采 15:00 后 Sentry 已接收 span：`runtime_config` 535（p95 123.9ms）、`users` 340（p95 69.7ms），当前时延健康但请求量仍可收敛；不以继续缩短 timeout 作为方案。
