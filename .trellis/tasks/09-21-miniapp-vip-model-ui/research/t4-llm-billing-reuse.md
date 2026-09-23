# T4 复用调研、失败路径与验证计划

日期：2026-09-22。分支 `dev_vip_0920`，HEAD `2f2eb0e`，与 `origin/dev_vip_0920` 同步，开始时工作区干净。父任务已是 `in_progress`。本会话 `task.py current` 无 session identity 时不重复 `task.py start`，也不新建任务。

## 范围

只做 LLM：模型 config / select / generation 的服务端 VIP 与可用钱包校验；到期后下一轮回落轻量并 best-effort 修正持久化选择；受理时固化报价；`charge_llm_usage` 接入已有 `apply_wallet_debit`；消费明细带出拆分和价格快照；已扣后退款走 `refund_wallet_debit`。

不进入语音/图片状态机、媒体 routes、媒体领域契约和媒体 UI。不改 T2/T3 已 apply 的 migration。不开启 VIP 购买、提醒或高级图片。不操作 Production。正式 test apply 停在批准前。

## 复用

| 现有对象                                                                          | 决定                                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `quoteTextModelUsage` / `roundHalfUpToInteger` / `resolveBillableCapabilityRules` | 复用。折扣、取整、钱包策略和 VIP 门槛只走这里。原价由调用方从 `getPricingConfig()` 传入。                                           |
| `apply_wallet_debit` / `refund_wallet_debit`                                      | 复用。不在应用层改 `main_credits` / `bonus_credits`。                                                                               |
| `charge_llm_usage` 签名、`finish_reason` 闸门、pending、sync-job                  | 扩展函数体。保留 `pending_finish_reason` / `non_billable` / `billable`。deferred sync 仍读 `llm_billing_snapshot.fixed_deduction`。 |
| `features/generation` 的 execute → settle / sync-job → `applyLlmCharge`           | 扩展快照字段。不改图片上游适配，不改 `chargeVoiceUsage`。                                                                           |
| `VipStatusService.getStatus`                                                      | 复用。读失败已是 fail closed（非 VIP）。                                                                                            |
| `MiniappWalletRepository.listSpending`                                            | 只给 LLM 行补可选字段，并多查 `reason=llm_usage` 的退款流水。语音/图片查询条件不变。                                                |
| `toPublicModelCatalog`、`GetModelCatalogData`、`WalletSpendingRecord` 可选字段    | 复用 T1 已冻结形状。不改根出口，不新增必填字段。                                                                                    |
| 历史 `partial` 行                                                                 | 只读兼容。新结算不再写入 `partial`。                                                                                                |

不复用旧 `charge_llm_usage` 里「先扣 bonus、不足则 partial」的分配。那和已冻结的 `main_then_bonus` / `main_only` 冲突。

## 失败与兼容

- 标准/旗舰且 VIP 无效：选择接口返回 `VIP_REQUIRED`，不改持久化选择。生成入口在开轮前解析为轻量模型；没有轻量档时失败关闭，不用旗舰顶上。修正持久化失败只记日志，本轮仍用轻量。
- 模型目录 GET 计算锁和报价，并同样回落已过期的标准/旗舰选择。GET 不因余额不足返回 402，否则面板无法展示价格。硬性余额拒绝在 select 和生成预检。
- 可用余额：`main_only` 只看充值钱包，`main_then_bonus` 看两钱包合计。402 的 `credits_available` 用这个口径，避免用总余额误导旗舰用户。
- 免费轮优先：`payable=0`，不叠 95 折。VIP 三档才按运行时原价 × 0.95 四舍五入。
- 受理快照写入 `fixed_deduction`（实付）以及原价、折扣、策略、VIP 截止时间。sync 重放和 `charge_llm_usage` 都先用已落库的 `payable_credits` / `fixed_deduction`，不用后来的目录价。
- 余额在预检后被花掉：RPC 抛出 `MAIN_CREDITS_INSUFFICIENT` 或 `TOTAL_CREDITS_INSUFFICIENT`，整笔回滚，不写 partial。pending 行保持 pending，交给现有 sync 重试。用户可见的不足在预检 402。
- 已扣后补偿入口是 `compensateDebitedLlmCharge` → `billing.refund_llm_usage_charge` → `refund_wallet_debit`。成功后 charge 行保持 `charged`（旧 DTO 状态枚举不变），metadata 记 `compensation_status=refunded`。流水 reason 固定 `llm_usage`。没有 `debit_key` 的历史扣款返回 `not_refundable`，不动余额。重复退款返回 `already_refunded`。
- 结算成功后的 history 写失败不自动退款。sync 对同一 `charge_key` 重放，不会二次扣款。

## 迁移

新文件 `packages/shared/migrations/20260922_llm_vip_wallet_charge.sql`。

- 归属：`billing`。替换 `billing.charge_llm_usage` 函数体，并新增补偿函数 `billing.refund_llm_usage_charge`。不新建表，不改钱包列。
- 前置：T2 `apply_wallet_debit` / `refund_wallet_debit`，以及已存在的 `billing.llm_usage_charges`。
- 锁：`CREATE OR REPLACE FUNCTION`，`lock_timeout=5s`，`statement_timeout=60s`。不建索引，不回填历史流水。
- 权限：DEFINER，`search_path=pg_catalog`，REVOKE PUBLIC/anon/authenticated，仅 service_role/postgres。
- 发布：Backend 必须在该文件 apply 之后才按新策略扣款。未 apply 时旧函数仍是 bonus 优先且允许 partial。
- 恢复：未产生新 VIP 文本扣款前，可用 forward-fix 把函数体换回。已扣款后不 down migration，补偿走退款 RPC。

正式 test apply 仍须 GitHub Actions 单文件执行，本轮未获批准，不执行。

## 共享文件（给后续合并）

- `packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts`：LLM 扣费错误仍原样抛出；新增退款 RPC；消费明细只扩展 LLM 与 `llm_usage` 退款行。
- `packages/backend/src/features/generation/`：计费快照、预检、解析、settle/sync。不改 image 子目录。
- `scripts/test-vip-billing-migrations.sh`：在 T3 之后追加 T4 本地场景。
- 不改 `packages/shared/src/index.ts`，不改语音/图片实现。

## 验证

本地：shared 测试、backend 相关测试、全消费者 typecheck、lint:imports / legacy / migrations、migration ledger、`scripts/test-vip-billing-migrations.sh`。

SQL 场景覆盖：免费优先、只有 bonus、main-only 拒绝 bonus、余额竞态不 partial、快照不被后到价格改写、pending 后 sync、重复扣款、重复退款、历史 partial 只读、无 debit_key 不退款。

未包含：正式 test apply、真实 OpenRouter、Production。
