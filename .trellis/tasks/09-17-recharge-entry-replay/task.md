# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                           | Files / Scope   | Depends On | Verification                              |
| --- | ------ | ------------------------------ | --------------- | ---------- | ----------------------------------------- |
| T1  | Done   | 生命周期和 SDK 启停            | telemetry       | -          | lifecycle/adapter tests                   |
| T2  | Done   | 入口、外链、回流和 reload 集成 | payment/profile | T1         | flow/return tests                         |
| T3  | Doing  | 规范与质量门禁                 | specs           | T2         | typecheck/test/lint/build; Preview manual |

## Execution Log

- 2026-09-17：Frontend 153 tests、`pnpm -r typecheck`、Frontend lint/build、`git diff --check` 通过。
- Preview 真机仍须检查直接入口与聊天付费墙各一次：相同 `replay_context_id` / `$session_id` 的事件链、recording 网络片段与可播放 Replay；打开第三方支付后无 MiniApp recorder 继续采集，返回后仅 MiniApp 内恢复。Production 配置保持关闭。
