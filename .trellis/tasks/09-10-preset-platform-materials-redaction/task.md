# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task               | Files / Scope          | Depends On | Verification    |
| --- | ------ | ------------------ | ---------------------- | ---------- | --------------- |
| T1  | Todo   | 设计素材只读边界   | backend/database       | Backend/DB | 只读证明        |
| T2  | Todo   | 当前环境角色卡导入 | backend repository/API | T1         | 下架/无权限测试 |
| T3  | Todo   | 真实输入查询与脱敏 | backend redaction      | T1         | PII fixture     |
| T4  | Todo   | 日志/遥测检查      | logger/Sentry context  | T3         | 无原文          |
| T5  | Todo   | 零写入验证         | DB/API tests           | T2,T3      | 业务域无写入    |
| T6  | Todo   | 更新 spec 文档     | backend/database spec  | T5         | spec diff 已审  |

## Execution Log

- 2026-09-10：从父任务拆出，作为测试素材与脱敏独立任务。
