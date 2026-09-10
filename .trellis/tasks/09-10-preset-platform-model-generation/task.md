# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                             | Files / Scope             | Depends On   | Verification             |
| --- | ------ | -------------------------------- | ------------------------- | ------------ | ------------------------ |
| T1  | Todo   | 调研 Admin/OpenRouter/generation | admin/backend/shared      | Backend 基座 | 复用记录                 |
| T2  | Todo   | 模型目录端点与限频               | backend models            | T1           | fresh/stale/refresh 测试 |
| T3  | Todo   | internal test generation purpose | backend generation        | T2           | 无计费副作用             |
| T4  | Todo   | composer/SSE/idempotency         | backend preset generation | T3           | fake upstream E2E        |
| T5  | Todo   | 故障与恢复测试                   | backend tests             | T4           | 4xx/5xx/429/timeout/断线 |
| T6  | Todo   | 更新 spec 文档                   | backend/shared spec       | T5           | spec diff 已审           |

## Execution Log

- 2026-09-10：从父任务拆出，作为模型目录与内部生成独立任务。
