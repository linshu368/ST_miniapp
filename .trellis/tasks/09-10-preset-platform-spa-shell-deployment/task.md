# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                       | Files / Scope                  | Depends On     | Verification      |
| --- | ------ | -------------------------- | ------------------------------ | -------------- | ----------------- |
| T1  | Todo   | 新建 workspace 包          | `packages/preset-platform`     | Shared/Backend | dev/typecheck     |
| T2  | Todo   | app shell/providers/router | app/layout/lib                 | T1             | smoke             |
| T3  | Todo   | 环境切换与登录             | environment/supabase/auth      | T2             | fail-fast/隔离    |
| T4  | Todo   | Vercel/CI/Railway env 配置 | vercel.json/workflows/.railway | T3             | preview 只连 test |
| T5  | Todo   | 文档/spec 初版             | README/ARCHITECTURE/spec       | T4             | spec diff 已审    |

## Execution Log

- 2026-09-10：从父任务拆出，作为新 SPA 基座与部署独立任务。
