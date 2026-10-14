# Task Breakdown

| ID | Status | Task | Files / Scope | Depends On | Verification |
| -- | ------ | ---- | ------------- | ---------- | ------------ |
| T1 | Todo | Migration + runtime_config 开关种子与 Admin allowlist | `packages/shared/migrations/*`；admin validate | - | migration dry shape；Admin 可读 boolean |
| T2 | Todo | shared snapshot `prompt_zh` 契约 | `packages/shared/src/api/image-plaza.ts`；契约测试 | T1 可并行 | shared test |
| T3 | Todo | backend 读开关；feed/bootstrap/share 分支 | `config.ts`；`routes/image-plaza.ts`；tagging 调用点 | T1 | 单测：关则不打标 |
| T4 | Todo | listWorks 中英 OR 搜索 | `repository.ts` | T2 | 单测或手工 SQL 条件 |
| T5 | Todo | 详情只展示中文（回退英文） | `work/[workId]/page.tsx` | T2 | 人工：有/无 prompt_zh |
| T6 | Todo | Admin 注册 boolean key | `configSchemas.ts` 等 | T1 | Admin 草稿发布 |
| T7 | Todo | 翻译脚本 + Venice translate helper | `scripts/*`；`features/image-plaza/*` | T2 | dry-run；小批 apply 幂等 |
| T8 | Todo | 回归：同款英文、用户创作原文、开关切换 | 跨端 | T3–T7 | AC01–AC08 |

## Execution Log

- 2026-10-14：规划收敛；待最终摘要确认。
