# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                     | Files / Scope                     | Depends On | Verification                       |
| --- | ------ | -------------------------------------------------------- | --------------------------------- | ---------- | ---------------------------------- |
| T1  | Done   | 核对日报、当前提交、冲突与既有优化，冻结本轮可控瓶颈     | 报告、git、相关 specs/modules     | -          | 证据写入 design.md                 |
| T2  | Done   | 优化角色首屏图片优先级、Profile 关键请求和工作室配置预热 | frontend character/profile/create | T1         | frontend tests/typecheck/lint      |
| T3  | Done   | 将选集面板移出短剧初始 chunk，保持首次交互               | drama-player/episode-sheet        | T1         | build + 定向 UI 测试               |
| T4  | Done   | 并行聊天独立准备并异步执行流后建议性诊断                 | backend conversations/generation  | T1         | generation/route tests + typecheck |
| T5  | Done   | 全量验证、检查差异并记录剩余生产风险                     | frontend/backend/task docs        | T2,T3,T4   | build/tests/diff-check             |
| T6  | Done   | 更新任务记录并自动归档任务（不自动 commit/push）         | Trellis task                      | T5         | task archive --no-commit           |

## Execution Log

- 2026-10-30：确认 `fix_request_speed` 无 unresolved conflict；日报显示 support unread 健康，聊天首字与完整流必须分开判断。
- 2026-10-30：完成复用、可靠性、最小方案、恢复和可验证性门禁，任务进入 `in_progress` 后实施。
- 2026-10-30：完成角色首屏图片、Profile 余额、影像配置预热、短剧选集 chunk、聊天准备和流后诊断六项优化。
- 2026-10-30：前后端全量单元测试、workspace typecheck、frontend lint 与 production build 通过；Profile UI 12/12 通过。
- 2026-10-30：短剧关键 UI 3/4、roleplay 10/12；失败均集中于 Android 首次 Next 动态路由编译/热更新窗口，接口返回正常，详见 verification.md。
- 2026-10-30：复核差异并按用户要求以 `--no-commit` 自动归档；未 commit、未 push。
