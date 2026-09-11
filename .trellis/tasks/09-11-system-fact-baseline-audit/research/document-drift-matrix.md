# 文档漂移矩阵

## P0：会误导实现、迁移或安全判断

| ID    | 漂移                                                                                    | 证据                                                                                   | 目标文件                                                                             | 后续任务                 |
| ----- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| P0-01 | migration spec 仍要求沿用三位编号；现行规则已改为日期命名、账本查重和 `psql` 单文件执行 | `scripts/check-migration-filenames.mjs`、`.github/workflows/db-migrate.yml`、`009a4b0` | `.trellis/spec/database/supabase/migrations-and-rollbacks.md`、database index/module | package-spec-module-sync |
| P0-02 | README 仍把 `ST_*` 和 `LLM_PROXY_TOKEN_SECRET` 列为现行 backend 配置                    | `platform/config.ts`、legacy guard、ARCHITECTURE §11                                   | `README.md`                                                                          | docs-workflow-gate-sync  |
| P0-03 | shared spec 仍描述已删除的 `st-bridge` 目录/导出                                        | `packages/shared/src/index.ts`、legacy guard `deleted-packages`                        | shared architecture/exports、utilities/fixtures spec                                 | package-spec-module-sync |
| P0-04 | module knowledge 未反映 `applyLlmCharge` 唯一应用层定档扣费入口                         | `features/generation/apply-charge.ts`、`bae09ea`                                       | `backend.business.conversation-generation`、billing module                           | package-spec-module-sync |
| P0-05 | module/spec 仍可能把旧模型 tiers 或回退写成现行能力                                     | `platform/model-tiers.ts`、`d9d85d8`、`dbe55ce`                                        | backend/shared 相关 spec 与 modules                                                  | package-spec-module-sync |

## P1：会造成模块理解或交付门禁漂移

| ID    | 漂移                                                                                | 证据                                                  | 目标文件                                              | 后续任务                 |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------ |
| P1-01 | 六类星尘发奖统一入口未进入模块知识                                                  | `20260911_billing_grant_bonus_credits.sql`、`9b77eca` | engagement、wallet/payment、billing modules           | package-spec-module-sync |
| P1-02 | frontend module/spec 未完整反映 P3 hooks 和充值跳转收口                             | `e6df087` 及当前 hooks                                | frontend conversation module/spec                     | package-spec-module-sync |
| P1-03 | 部分验证说明仍引用已删除阶段 UAT/回归脚本或 botlink                                 | `package.json`、`88e8a50`                             | backend/module specs、README/ARCHITECTURE/实施方案    | 两个后续任务             |
| P1-04 | backend/frontend spec 仍引用已删除的包级 `CLAUDE.md`，process spec 也保留其同步责任 | 当前文件树、ARCHITECTURE §12                          | package index、docs process                           | 两个后续任务             |
| P1-05 | 注释规则未明确简单自解释方法无需注释；inline/check 路径不完全一致                   | agents、Cursor check skill、package specs             | AGENTS、workflow、agents、skill、package/process spec | docs-workflow-gate-sync  |
| P1-06 | “新函数必有单测”“关键逻辑要补测试”等表述会触发自动生成 test 文件                    | `.cursor/skills/trellis-check/SKILL.md`、agents/spec  | 同上                                                  | docs-workflow-gate-sync  |
| P1-07 | ARCHITECTURE 中 managed config 数量、完成项与待办可能自相矛盾                       | `packages/admin` 当前配置入口与 ARCHITECTURE §3/§10   | `docs/ARCHITECTURE.md`、实施方案                      | docs-workflow-gate-sync  |

## P2：清晰度、重复与维护性问题

| ID    | 漂移                                                             | 建议                                                                    | 后续任务                 |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| P2-01 | README 与 ARCHITECTURE 重复大段动态清单，易再次漂移              | README 保留入门摘要，深层事实链接 ARCHITECTURE/spec                     | docs-workflow-gate-sync  |
| P2-02 | module knowledge 基线停在 2026-09-08，缺少 9 月 10–11 日变更记录 | 按证据更新声明 module IDs，并由工具重建索引                             | package-spec-module-sync |
| P2-03 | 历史 migration 与当前规则混写                                    | 明确“冻结历史”与“新迁移规则”两段，禁止按编号推断                        | package-spec-module-sync |
| P2-04 | 测试文件创建与验证执行被混为一件事                               | 分开写：默认不新建 test；现有测试/typecheck/lint/build/人工回归照常执行 | docs-workflow-gate-sync  |

## 建议更新的模块

- `backend.business.conversation-generation`
- `backend.business.engagement-support`
- `backend.infrastructure.runtime-data-security`
- `frontend.business.conversation-ui`
- `shared.business.conversation-contracts`
- `shared.infrastructure.database-environment`
- `database.business.billing-payment`
- `database.infrastructure.schema-security`

最终模块集合以实施时再次核对代码后的 `task.json.meta.module_impact` 与 `module-updates.json` 为准。
