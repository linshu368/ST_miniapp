# Task Breakdown

| ID | Status | Task | Files / Scope | Depends On | Verification |
| -- | ------ | ---- | ------------- | ---------- | ------------ |
| T1 | Done | Migration + runtime_config 开关种子与 Admin allowlist | `20261014_image_plaza_tags_feature_and_prompt_zh.sql` | - | SQL 就绪；待手工执行 test |
| T2 | Done | shared snapshot `prompt_zh` 契约 | `shared/src/api/image-plaza.ts`；契约测试 | - | shared image-plaza-contracts 8 passed |
| T3 | Done | backend 读开关；feed/bootstrap/share 分支 | `config.ts`；`routes/image-plaza.ts` | T1/T2 | config + share 单测通过 |
| T4 | Done | listWorks 中英 OR 搜索 | `repository.ts` | T2 | 代码落地；依赖 migration 后人工搜 |
| T5 | Done | 详情只展示中文（回退英文） | `work/[workId]/page.tsx`；feed 隐藏空标签行 | T2 | 代码落地 |
| T6 | Done | Admin 注册 boolean key | `configSchemas` / `adminNavigation` / `ConfigValueEditor` | T1 | 代码落地 |
| T7 | Done | 翻译脚本 + Venice translate helper | `image-plaza-prompt-translate.ts`；`seed-prompt-translate.ts`；script | T2 | dry-run/apply 待 test 库执行 |
| T8 | Done | 回归单测与 typecheck | backend/shared | T3–T7 | backend typecheck OK；广场相关 21 tests passed |

## Execution Log

- 2026-10-14：规划确认后实施代码落地；migration 与翻译脚本待在确认的 test 库手工执行。
