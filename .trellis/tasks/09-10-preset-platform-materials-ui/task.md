# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task             | Files / Scope                  | Depends On          | Verification         |
| --- | ------ | ---------------- | ------------------------------ | ------------------- | -------------------- |
| T1  | Todo   | 角色卡选择 UI    | materials page/hooks           | SPA shell + backend | 搜索/分页/环境       |
| T2  | Todo   | 脱敏输入样本 UI  | materials page/hooks           | T1                  | 空态/错误态          |
| T3  | Todo   | 当前会话载入动作 | materials + conversation state | T2                  | 不自动发送           |
| T4  | Todo   | UI 测试与 build  | preset-platform tests          | T3                  | typecheck/test/build |
| T5  | Todo   | 更新 spec 文档   | preset-platform spec           | T4                  | spec diff 已审       |

## Execution Log

- 2026-09-10：从父任务补拆，补足测试素材前端页面范围。
