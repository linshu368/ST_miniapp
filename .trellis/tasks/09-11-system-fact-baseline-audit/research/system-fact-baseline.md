# 系统事实基线

> 审计基准：`HEAD=372fa4b`。`449cdda..HEAD` 不包含起点提交自身，因此本文将 `449cdda` 作为 P1 基线一并核对。当前实现、CI/部署配置和 guard 优先于说明文档；仓库无法证明的远端环境状态均标记为待人工确认。

## 结论摘要

| 领域          | 当前事实                                                                                                        | 主要证据                                                                                                                                                         | 状态                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 包与运行单元  | pnpm workspace 只有 frontend、backend、admin、cs-platform、shared；`botlink/` 已删除                            | `pnpm-workspace.yaml`；`88e8a50`                                                                                                                                 | 现行                         |
| ST 退场       | ST 代码、schema 和应用消费入口已删除；`ST_*` 只可能是部署控制台遗留                                             | `scripts/check-legacy-references.mjs`；`docs/ARCHITECTURE.md`；`88e8a50`                                                                                         | 代码已退场，控制台待确认     |
| 迁移治理      | 新迁移使用 `YYYYMMDD_描述.sql`；手动 Action 以 `psql --file` 执行；账本为 `supabase_migrations.repo_migrations` | `scripts/check-migration-filenames.mjs`；`.github/workflows/db-migrate.yml`；`20260910_schema_migrations_ledger.sql`；`449cdda`、`82d254d`、`daaa9f3`、`009a4b0` | 代码现行，实库记录待确认     |
| LLM 计费      | 即时结算与 fixed-tier 回捞共用 `applyLlmCharge`；历史 usage 对账保留 `reconcileLlmUsage`；语音计费独立          | `features/generation/apply-charge.ts`、`settle.ts`、`sync-job.ts`；`bae09ea`                                                                                     | 现行                         |
| 模型目录      | 只有 `llm_model_catalog`；旧 tiers 契约、端点、双缓存及运行时回退已删除                                         | `platform/model-tiers.ts`；shared models 契约；`d9d85d8`、`dbe55ce`                                                                                              | 现行                         |
| 前端聊天编排  | session 生命周期与 turn 流式编排已拆入 hooks，充值跳转收口；page 保留接线、布局与语音                           | `hooks/use-chat-session.ts`、`hooks/use-conversation-turn.ts`、`lib/recharge-redirect.ts`；`e6df087`                                                             | 现行                         |
| 星尘发奖      | 注册、签到、许愿、运营赠送、邀请、社群 RPC 最终统一调用 `billing.grant_bonus_credits`                           | `20260911_billing_grant_bonus_credits.sql`；legacy guard `wallet-bonus-grant`；`9b77eca`                                                                         | 代码已落地，目标库执行待确认 |
| CI 与退场保护 | 无凭证单测进入 quality gate；legacy guard 阻止 ST、旧 schema、旧模型、重复计费/发奖出口复活                     | `.github/workflows/ci.yml`；`scripts/check-legacy-references.mjs`；`7a91a24`、`aab13d3`                                                                          | 现行                         |
| 阶段脚本      | 阶段 UAT、旧回归脚本和 botlink 已清理，不得继续作为现行验证入口                                                 | `package.json`；`88e8a50`                                                                                                                                        | 已退场                       |

## 事实边界

- `docs/ARCHITECTURE.md` 是项目级当前事实入口，但仍有局部计数、待办或环境状态可能滞后，不能替代代码核验。
- `packages/shared/migrations/` 是唯一 migration 源；历史三位编号文件不可改写，新文件不得延续编号。
- test 与 production 不保证同构。migration 存在于仓库只证明“可执行”，不证明目标环境已执行。
- legacy guard 的 allow 清单代表刻意保留的唯一出口；扩 allow 等同新增出口，需单独评审。
- 本轮只同步文档与规则，不裁决 Railway/Vercel/Supabase 控制台遗留，也不改产品行为。

## 需人工或环境确认

1. `supabase_migrations.repo_migrations` 在 test/production 的实际建表及记录状态。
2. Railway production 中 `nginx-pro`、`st-bundle-pro`、`st-data-pro`、`ST_*` 与废弃 PR 环境是否已清理。
3. `users.st_handle` 的 111/112 两阶段迁移在各环境的真实执行进度。
4. 文档中任何“test 与 production 一致”的陈述，除非附带同一时间点的环境证据，否则应降级为待确认。
