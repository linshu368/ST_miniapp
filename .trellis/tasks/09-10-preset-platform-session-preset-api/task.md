# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task               | Files / Scope                        | Depends On           | Verification           |
| --- | ------ | ------------------ | ------------------------------------ | -------------------- | ---------------------- |
| T1  | Todo   | 会话 API           | backend routes/features/repositories | Shared/DB/Foundation | 私有过滤测试           |
| T2  | Todo   | 预设库/草稿 API    | backend routes/features/repositories | T1                   | CRUD/apply/conflict    |
| T3  | Todo   | 默认发布/回滚 API  | backend routes/features/repositories | T2                   | revision/audit/confirm |
| T4  | Todo   | 错误/日志/权限测试 | backend tests                        | T1-T3                | 401/403/409/422        |
| T5  | Todo   | 更新 spec 文档     | backend/shared spec                  | T4                   | spec diff 已审         |

## Execution Log

- 2026-09-10：从父任务补拆，承接原 T4 中过宽的会话、草稿、发布 API 范围。
