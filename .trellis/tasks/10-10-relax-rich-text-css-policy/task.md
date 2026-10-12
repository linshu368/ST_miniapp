# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                            | Files / Scope                 | Depends On | Verification                          |
| --- | ------ | ----------------------------------------------- | ----------------------------- | ---------- | ------------------------------------- |
| T1  | Done   | 扩展 CSS artifact contract 与 runtime denylist  | shared api/css-model/validate | -          | shared tests + typecheck              |
| T2  | Done   | 改造 compiler selector/value 转换与 diagnostics | shared compile-css            | T1         | 完整运营 CSS + unsafe fixtures        |
| T3  | Done   | 增加 renderer containment 与最终防线            | reply-renderer                | T1         | renderer typecheck; full test pending |
| T4  | Todo   | 更新架构/spec 与跨消费者验证                    | docs/spec + all consumers     | T1-T3      | test/typecheck/build/lint             |

## Execution Log

- 2026-10-10：从 `origin/dev@b3bc63ce` 创建 `codex/hotfix-rich-text-css-policy`；完成当前 compiler/artifact/renderer 复用调研和设计。
- 2026-10-12：任务启动后完成 T1–T3；Shared typecheck 与 20 项测试、ReplyRenderer typecheck 通过。全量跨消费者 build/测试留在 T4。
