# Task Breakdown

## Status Legend

- Todo / Doing / Done / Blocked / Skipped

## Tasks

| ID  | Status | Task                                                       | Files / Scope                                                                            | Depends On | Verification                       |
| --- | ------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| T1  | Done   | shared 契约：配置/prompt key、zod schema、默认值、板块提取 | `packages/shared/src/api/story-memory.ts`、index                                         | -          | shared typecheck/test              |
| T2  | Done   | 迁移：两张表、5 个 RPC、分支重写、删除旧泄洪、managed key  | `packages/shared/migrations/20261110_story_memory.sql`                                   | T1         | PG17 隔离回放                      |
| T3  | Done   | Backend 窗口计划 + 注入 + 删除 context-window              | `features/story-memory/*`、`features/conversations/*`、`features/engine/*`、repositories | T1         | 单测 + typecheck                   |
| T4  | Done   | Backend 压缩 worker + 模型调用 + 校验                      | `features/story-memory/*`、`features/generation/story-memory-compress.ts`、`app.ts`      | T1,T2      | 单测 + 样例故事真实调用            |
| T5  | Done   | 分支调用方改为 4 参数                                      | `ChatSessionRepository.ts`、`routes/conversations.ts`                                    | T2         | typecheck + 现有分支测试           |
| T6  | Done   | Admin 注册与编辑器                                         | `admin-client/configSchemas.ts`、`menu.ts`、`admin/ConfigValueEditor`                    | T1         | admin typecheck/test、CLI coverage |
| T7  | Done   | 文档与 spec 更新                                           | README/ARCHITECTURE/migrations README、modules                                           | T1-T6      | -                                  |

## Execution Log

- 2026-11-10 实现完成：backend/shared/admin/admin-client/admin-cli typecheck 与测试通过（backend 1480 通过，仅需 Docker 的 lobby 集成测试因环境跳过）；`bash scripts/test-story-memory-migration.sh` PG17 通过；lint:complexity/migrations/imports/legacy 通过。真实压缩模型回放待有 LLM_API_KEY 的 TEST 环境执行。

- 2026-11-10 规划完成，用户确认简化方案（无影子/灰度、旧逻辑全删、存量自然补齐、开发后做基本测试）。
