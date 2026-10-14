# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                          | Files / Scope                               | Depends On | Verification                                 |
| --- | ------ | --------------------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------- |
| T1  | Done   | 用专用 `pg` session 管理 Worker advisory lock | monitor script / small lease helper         | -          | 单连接 acquire/release、异常清理、未获锁跳过 |
| T2  | Done   | 回归验证与发布证据准备                        | backend tests/typecheck、部署后日志检查清单 | T1         | 单测、typecheck、相关测试、diff check        |

## Execution Log

- 2026-10-12：生产只读排查确认 `notifications_enabled=true` 且 Webhook 已配置，但 Worker 最后心跳后出现 Prisma P2024 连接池耗尽。现有脚本通过 Prisma pool 分别调用 session-level `pg_try_advisory_lock` 与 `pg_advisory_unlock`，不保证同 session，纳入本 hotfix。
- 2026-10-12：实现 `postgres-advisory-lease`。锁专用 client 使用 `DIRECT_URL` 而不是指向 pooler 的 `DATABASE_URL`；同一 client acquire → 一轮监控/投递 → unlock → close。生产只读 `SELECT 1` 已确认 `DIRECT_URL` 可连通，未读取业务数据或持锁。新 helper 三条测试、支付/告警相关 20 条测试、Backend typecheck 和 `git diff --check` 通过。完整 Backend 套件为 641/643 通过，`notifications.test.ts` 两条既有测试超时，与本次文件无交集，未作为通过结论。
