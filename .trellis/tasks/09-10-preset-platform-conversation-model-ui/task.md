# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task             | Files / Scope          | Depends On       | Verification     |
| --- | ------ | ---------------- | ---------------------- | ---------------- | ---------------- |
| T1  | Todo   | 对话页布局       | conversations UI       | SPA shell        | screenshot/smoke |
| T2  | Todo   | 私有会话状态     | sessions hooks/UI      | T1               | A/B 隔离         |
| T3  | Todo   | 模型目录和下拉   | models UI/hooks        | Model generation | Admin 同口径     |
| T4  | Todo   | SSE 状态和 retry | conversation stream UI | T2,T3            | 故障 E2E         |
| T5  | Todo   | 更新 spec 文档   | preset-platform spec   | T4               | spec diff 已审   |

## Execution Log

- 2026-09-10：从父任务拆出，作为会话与模型 UI 独立任务。
