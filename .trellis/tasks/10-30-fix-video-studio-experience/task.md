# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                  | Files / Scope                   | Depends On | Verification                                 |
| --- | ------ | ----------------------------------------------------- | ------------------------------- | ---------- | -------------------------------------------- |
| T1  | Done   | 修正 Venice queue duration wire format 并补强既有回归 | backend video-upstream + test   | -          | targeted test + typecheck                    |
| T2  | Done   | 消除终态 attempt N+1 与消息 O(n²) 查找                | frontend API + studio page      | T1         | typecheck + existing tests                   |
| T3  | Done   | 按需加载低频面板并优化模型 Sheet / 长标题 header      | studio page + video-model-sheet | T2         | lint/build + @image + manual narrow viewport |
| T4  | Done   | 全量验证、规范审查与任务记录                          | affected packages + Trellis     | T1-T3      | commands in implement.md                     |

## Execution Log

- 2026-10-30：Railway PR-566 证实 route 202、worker Venice queue 400；官方契约确认 duration 必须为 `<n>s` 字符串。
- 2026-10-30：复用/可靠性/最小方案/恢复/验证门禁已写入 design.md 与 implement.md，待开始实现。
- 2026-10-30：实现 provider 边界格式化、终态 attempt cache seed、O(n) prompt 映射、低频面板动态加载及 Sheet/Header 布局优化。
- 2026-10-30：后端定向测试 3/3、前端测试 652/652、typecheck、lint、build、`@image` 8/8 与 `git diff --check` 通过；lint 仅有既有 `<img>` 警告。
- 2026-10-30：任务 context 校验通过；module knowledge 检查被仓库既有 `frontend/app/modules/index.md` 索引漂移阻断，本任务声明不改变模块知识且未重建无关索引。
