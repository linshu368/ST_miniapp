# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                          | Files / Scope                                            | Depends On | Verification                                     |
| --- | ------ | --------------------------------------------- | -------------------------------------------------------- | ---------- | ------------------------------------------------ |
| T1  | Done   | 修正 Railway VIP Cron 启动命令并同步文档/断言 | `.railway/railway.ts`、Railway README、既有 Backend test | -          | targeted test、typecheck、diff check、两环境配置 |

## Execution Log

- development 现场从裸 `tsx` 改为 `./node_modules/.bin/tsx`，redeploy `4c2479fc-f8a3-4cb4-85f0-1d8bf7f6d5cd` 成功。
- production 同字段已修正，redeploy `6c55872e-477b-470b-b838-6a47a784805a` 成功。
- Railway 两环境保持 `20 * * * *`、Restart Policy `NEVER`；其他服务、变量、数据库和功能开关未修改。
- 验证通过：VIP reminder targeted test（13/13）、Backend typecheck、`git diff --check`。
- 下一次真实计划执行为 `2026-10-01T09:20:00Z`；运行摘要需在调度后从 `vip.reminder.finished` 或 fail-closed 日志确认，不作为本次命令路径修复的静态门禁。
