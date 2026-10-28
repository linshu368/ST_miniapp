# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                      | Files / Scope                 | Depends On | Verification                                        |
| --- | ------ | --------------------------------------------------------- | ----------------------------- | ---------- | --------------------------------------------------- |
| T1  | Done   | 固化 canonical protocol 并退休 INTERACTION_MODE 校验      | shared/admin/backend/database | -          | shared/backend tests + migration ledger             |
| T2  | Done   | 定义固定协议的结构化解析                                  | shared/backend                | T1         | complete/malformed protocol fixtures                |
| T3  | Done   | 复用 Renderer 的 trusted-slot consumer                    | reply-renderer/admin/frontend | T2         | renderer tests + consumer typecheck                 |
| T4  | Done   | 移除 choices/status/memory 对运营 regex/CSS bundle 的依赖 | shared/admin                  | T1         | canonical preview fixture                           |
| T5  | Done   | 复用既有 Worker 生命周期与同构预览                        | reply-renderer/admin          | T3         | renderer worker suite                               |
| T6  | Doing  | 文档、跨包门禁和 TEST 发布验收                            | docs/spec/all consumers       | T1-T5      | local gates complete; TEST migration/deploy pending |

## Execution Log

- 2026-10-12：创建 planning 任务；完成现状检索、复用边界、可靠性、兼容/回滚和验证计划。任务未 start，等待用户审核。
- 2026-10-12：用户批准后 start。新增 `rich-reply-protocol.ts` 作为版本化协议源；固定模块在 shared 中先解析为 trusted slot，畸形模块保留原文，Renderer 复用既有 worker/choice transport。
- 2026-10-12：新增 forward migration `20261012_retire_interaction_mode_placeholder.sql`；Admin、Backend 与 DB validator 均只要求 WORD_COUNT / USER_CUSTOM_INSTRUCTIONS，旧模板中的 retired token 在渲染时被移除。
- 2026-10-12：本地 shared/backend/renderer 回归、四个受影响包 typecheck、migration ledger 与 diff check 均通过。TEST migration、发布 canonical System Instructions 和实际页面验收仍需单独获准执行。
