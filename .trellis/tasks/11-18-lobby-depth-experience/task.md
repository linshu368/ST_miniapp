# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                         | Files / Scope                                                                                   | Depends On | Verification                       |
| --- | ------ | ---------------------------- | ----------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| T1  | Done   | 新增深度体验摘要表与契约登记 | `packages/shared/migrations/`, `docs/db/registry.yaml`                                          | -          | 迁移回归、catalog shape、RLS/grant |
| T2  | Done   | 接入后台日级聚合和持久化     | `packages/backend/src/features/lobby/`, `packages/backend/src/lib/lobby-ranking-refresh-job.ts` | T1         | 边界单测/集成测试、失败保留旧摘要  |
| T3  | Done   | 扩展角色社交聚合             | `packages/shared/migrations/20261118_character_deep_experience.sql`                             | T1         | RPC 计数相加、40 卡批量、EXPLAIN   |
| T4  | Done   | 完成跨包验证和审阅           | shared/backend tests/typecheck、日志门禁                                                        | T2,T3      | 全部命令通过，diff 只含本功能      |

## Execution Log

- 2026-11-18：确认采用“超过 20 轮计 1 次深度体验”，日级刷新，不增加大厅请求中的聊天历史扫描。
- 2026-11-18：新增 `character_deep_experience_stats` 派生摘要表；`get_character_socials` 将直接点赞、回复点赞和深度体验次数相加。
- 2026-11-18：迁移脚本、大厅评分集成测试、社交路由测试、Shared 测试、全仓 typecheck、Backend logging gate、迁移命名/契约检查通过。
