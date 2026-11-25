# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                      | Files / Scope                                                       | Depends On       | Verification                         |
| --- | ------ | --------------------------------------------------------- | ------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| T1  | Done   | 压短提示目标 70/25 + 原文字数                             | shared memory-bar/schema.ts、prompt.ts、memory-bar.test.ts          | -                | `pnpm --filter @miniapp/shared test` |
| T2  | Done   | 配置加可选 memory_primary_model                           | shared api/status-bar.ts                                            | -                | shared test、`pnpm -r typecheck`     |
| T3  | Done   | 记忆栏首发按 panel 选模型                                 | backend generation/status-bar-model.ts(+test)、memory-bar/update.ts | T2               | backend 相关测试                     |
| T4  | Done   | 后台编辑器可填/清空该字段，说明文案                       | admin StoryMemoryEditors.tsx、admin-client configMetadata.ts        | T2               | admin typecheck/lint                 |
| T5  | Todo   | 发布：后端上线后再用 admin CLI 发布配置（需用户确认差异） | 生产运营配置                                                        | T1-T4 合入并部署 | `config get` 复核；看板              |

## Execution Log

- 2026-11-25 规划：离线重放结论见 prd.md。
- 2026-11-25 T1-T4 完成：shared 398 测试、backend status-bar-model/memory-bar 25 测试、admin-cli 24 测试、`pnpm -r typecheck`、`pnpm lint`、`pnpm lint:complexity` 通过（本地需先 `prisma generate`，测试按 CI 设置占位 DATABASE_URL）。
