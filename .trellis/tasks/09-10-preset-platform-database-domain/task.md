# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                    | Files / Scope                | Depends On      | Verification              |
| --- | ------ | ----------------------- | ---------------------------- | --------------- | ------------------------- |
| T1  | Todo   | 扫描 migration 与域归属 | migrations/docs              | shared 契约草案 | 记录最新编号和风险        |
| T2  | Todo   | 设计表/RLS/grant/RPC    | `preset_platform`            | T1              | 设计审查                  |
| T3  | Todo   | 编写 migration          | `packages/shared/migrations` | T2              | SQL lint/人工审查         |
| T4  | Todo   | test 执行与验证         | Supabase test                | T3              | shape/RLS/RPC/concurrency |
| T5  | Todo   | 回滚/恢复说明           | 任务记录/docs                | T4              | 可操作                    |
| T6  | Todo   | 更新 spec 文档          | database spec/schema map     | T4,T5           | spec diff 已审            |

## Execution Log

- 2026-09-10：从父任务拆出，作为数据库独立域实现任务。
