# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                    | Files / Scope                                | Depends On | Verification    |
| --- | ------ | --------------------------------------- | -------------------------------------------- | ---------- | --------------- |
| T1  | Todo   | 复核现有 shared API 模式                | `packages/shared/src/api/*`                  | -          | 记录复用/差异   |
| T2  | Todo   | 定义 Preset Platform DTO/Zod/errors/SSE | `packages/shared/src/api/preset-platform.ts` | T1         | schema 测试     |
| T3  | Todo   | 导出契约                                | shared 根出口                                | T2         | 消费者可 import |
| T4  | Todo   | 补测试                                  | shared tests                                 | T2,T3      | shared test     |
| T5  | Todo   | 更新 spec 文档                          | `.trellis/spec/shared/contracts/*`           | T4         | spec diff 已审  |

## Execution Log

- 2026-09-10：从父任务拆出，作为 shared 契约独立实现任务。
