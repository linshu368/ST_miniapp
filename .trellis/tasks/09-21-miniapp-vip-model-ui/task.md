# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                           | Files / Scope                                        | Depends On                                  | Verification                                     |
| --- | ------ | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| T0  | Done   | 完成人工评审、test 环境与高级图片配置确认                      | task docs / env inventory                            | -                                           | 评审结论与环境证据齐全，满足停止条件检查         |
| T1  | Done   | 定义 VIP、支付、钱包、模型、通知及媒体免费公共契约与价格纯函数 | `packages/shared/src/api/*`                          | T0                                          | shared test/typecheck；旧字段兼容                |
| T2  | Done   | 添加会员/钱包/免费额度公共结构、RLS/grants、索引与原子 RPC     | `packages/shared/migrations/*`                       | T1                                          | test 单文件 migration、自检、守恒/并发/回滚演练  |
| T3  | Done   | 实现 VIP status、商品下单、支付原子履约与签到加成              | Backend VIP/payment/wallet routes + repositories     | T2                                          | 四路支付、续费、月卡赠送、60/120 与故障测试      |
| T4  | Todo   | 改造 LLM 权限、95 折、钱包分配、明细与原路退款                 | Backend models/generation/billing/wallet             | T2,T3                                       | 钱包矩阵、快照、并发、重放、退款回归测试         |
| T5  | Todo   | 向语音/图片子任务交付底座并完成跨模块集成验收                  | 两个 child task + parent integration                 | 语音等 T2；图片 basic 等 T2、advanced 等 T3 | 子任务证据、免费/钱包/权限联合矩阵               |
| T6  | Todo   | 实现 VIP 到期提醒、单条已读和消息详情 API                      | Backend reminder/notifications + Railway test config | T2,T3                                       | 时间窗口、续费竞态、去重、越权和 dry-run 验证    |
| T7  | Todo   | 更新我的页、VIP/充值、聊天模型、媒体与消息 UI                  | Frontend pages/components/hooks                      | T1,T3,T4,T5,T6                              | 前端 test/lint/typecheck/build + 人工状态矩阵    |
| T8  | Todo   | 完成跨包回归、test 必验路径、文档与模块知识更新                | 全仓、README、ARCHITECTURE、spec/module facts        | T1-T7                                       | 全量命令、test 证据、`module_knowledge.py check` |
| T9  | Todo   | 形成 Production 发布单并等待产品上线确认                       | migrations / Railway / feature flags                 | T8                                          | 未获明确确认保持 Production 关闭                 |

## Execution Log

- 2026-09-21：已完成需求、原型、仓库与规范调研；`prd.md`、`design.md`、`implement.md`、`task.md` 已进入评审。任务保持 `planning`，未执行 `task.py start`，未修改产品代码。
- 2026-09-21：规划审核后创建语音、图片两个子任务。媒体模块实现由原工程师负责；父任务保留公共底座、依赖交付和最终集成验收。
- 2026-09-21 T0：人工确认规划已审核。分支 `dev_vip_0920`。`implement.jsonl`/`check.jsonl` 已填真实条目后执行 `python3 ./.trellis/scripts/task.py start 09-21-miniapp-vip-model-ui`，父任务 `planning → in_progress`。子任务 `09-21-vip-voice-free-trials`、`09-21-vip-image-free-trials` 仍为 `planning`，未 start。按 `trellis-before-dev` 重载 frontend/backend/shared/database/guides 规范。只读核验见 `research/t0-environment-and-config-gate.md`。
  - 命令：`git branch --show-current` → `dev_vip_0920`；`task.py validate` 通过（implement 36 / check 25）；`task.py current --source` 指向本父任务。
  - 未连接数据库、未读业务行、未执行 migration、未改产品代码。当前会话无 Supabase MCP。正式 test ref 仓库声明为 `zoqelpfhurwehlvypryl`，本轮目标未获用户确认。
  - 高级图片：仓库无独立 provider/model/price/enabled；裁定保持关闭。
  - 签到 60：迁移链最后声明 40，Admin/展示 fallback 40，RPC fallback 10；test/production 实值未核。
  - Railway/支付四路配置入口在仓库可核对；Railway 实况与支付 test smoke、reminder Cron 均未 live 验证。
  - T0 状态 Blocked：活库采集与环境确认未完成，不进入 T1。未改 `AGENTS.md` 与数据库 spec。未 commit/push。
- 2026-09-21 T0 用户确认：开发/测试库 = `zoqelpfhurwehlvypryl`，生产 = `wbtsfzozlmurljvglhpn` 且本阶段不写入。只读 MCP 只采集结构，**真正 migration 仍须 GitHub Actions `db-migrate.yml` 单文件 apply**；用户因此授权接入只读 MCP。高级图片本迭代关闭。等 T0 采集完成后再进 T1。`dev_vip_0920` 由 `railway-pr-env.yml` 随 GitHub PR 自动部署 `pr-{N}`（复制 development，不碰 production）。本会话仍无 Supabase MCP，T0 继续 Blocked，未连库、未进 T1。
- 2026-09-21 T0 MCP 配置：用户新增 `.cursor/mcp.json`（已被 `.gitignore` 忽略，不入库）。`project-ref` 为正式 test `zoqelpfhurwehlvypryl`。原配置缺少 `--read-only`，已补上。本会话动态工具目录仍无 `supabase` namespace，未采集、未进 T1。禁止把 access token 写入任务文档或 Git。
- 2026-09-21 T0 采集完成：MCP `get_project_url` = `https://zoqelpfhurwehlvypryl.supabase.co`。只读 catalog 写入 `research/t0-test-db-collection.md`。test 签到配置=40；文本原价 light/standard/premium=15/30/50；初级图片 enabled=true 且 60 星尘；无高级图片键。规划 VIP 表/RPC 均不存在。未读业务行、未 apply migration、未进 T1。T0 → Done。Production 仍未核。
- 2026-09-21 T1：Shared contracts 与纯计价规则完成，T1 → Done。分支 `dev_vip_0920`。父任务已是 `in_progress`，本会话 `task.py current --source` 为 none（无 session identity），未重复执行 `task.py start`。未连库、未写 migration、未改 backend/frontend/voice/image 业务实现、未 start 子任务、未 commit/push。用户已有 `AGENTS.md` 与 database spec 改动未触碰。
  - 关键决策：VIP 商品商业条款（周卡 7/1399/0、月卡 31/2888/3000）作为产品事实写入 `VIP_PLAN_COMMERCIAL_TERMS`；文本原价必须由调用方传入，不把 T0 test 的 15/30/50 写成长期常量。现有 DTO 一律 additive 可选字段，保证旧 mapper/旧客户端 typecheck。媒体只提供 `feature-free-trials` 公共状态/错误码，不改 `voice.ts`/`images.ts` 请求响应。`CreatePaymentOrderRequest` 仍只收 `plan_id` + `payment_type`，用 `isVipPlanId` / `paymentProductTypeForPlanId` 分辨商品。
  - 改动文件：
    - 新增 `packages/shared/src/api/vip.ts`
    - 新增 `packages/shared/src/api/feature-free-trials.ts`
    - 新增 `packages/shared/src/__tests__/vip-billing-contracts.test.ts`
    - 扩展 `packages/shared/src/api/wallet.ts`、`payment.ts`、`models.ts`、`notifications.ts`
    - 根出口 `packages/shared/src/index.ts`
    - 本文件 `task.md`
  - 验证：
    - `pnpm --filter @miniapp/shared test` → 10 files / 88 tests passed
    - `pnpm --filter @miniapp/shared typecheck` → pass
    - `pnpm -r typecheck` → shared/admin/backend/frontend/cs-platform pass
    - `pnpm lint:imports` → pass
    - shared 无独立 lint script；已对 T1 文件跑 Prettier
  - 修改了公共 API：是。T2 必须遵守下方冻结清单，不得另起平行枚举/字段名。
  - 剩余风险：旧 `PaymentOrder`/`GetPaymentPlansData` 新字段在 T3 mapper 落地前为 `undefined`；T2 应用 DB default（credits / fulfillment=false）而不是要求 T1 把字段改成必填。Production schema 仍未核，T1 未使用 test 价作为产品事实。
- 2026-09-21 T2 本轮开始：分支 `dev_vip_0920`。父任务 `in_progress`。T0/T1 Done，T2 保持 Doing。未重复 `task.py start`。未写 test/production，未触发 GitHub Actions，未进 T3，未 start 子任务，未 commit/push。
- 2026-09-21 T2 本地完成（**停在 test apply 前，不得标 Done**）。MCP 目标 `https://zoqelpfhurwehlvypryl.supabase.co`（PG 17.6，无 pg_cron）。复用核验见 `research/t2-reuse-and-db-primitives.md`。T1 无字段改名冲突；折扣常量 0.95 不进入本轮 SQL。钱包列 `NUMERIC(14,1)`，RPC 拒绝非正且非整数金额。
  - 实际修改/新增：
    - `packages/shared/migrations/20260921_vip_billing_schema.sql`（第 1/4）
    - `packages/shared/migrations/20260921_wallet_debit_refund.sql`（第 2/4）
    - `packages/shared/migrations/20260921_vip_payment_fulfillment.sql`（第 3/4）
    - `packages/shared/migrations/20260921_feature_free_trial_checkin_reminder.sql`（第 4/4）
    - `packages/shared/migrations/fixtures/vip_billing_t2_harness.sql`（仅本地，禁止 apply 到 test/prod）
    - `packages/shared/migrations/tests/vip_billing_t2_scenarios.sql`（仅本地）
    - `scripts/test-vip-billing-migrations.sh`
    - `scripts/check-legacy-references.mjs`（allow 同一 `complete_payment_order` 函数体）
    - 本文件与 T2 research
  - 未触碰：T1 契约、`AGENTS.md`、database spec、语音/图片 attempt 列、签到奖励 40、Backend 调用方。
  - 依赖顺序：1 schema → 2 debit/refund → 3 payment fulfillment → 4 free-trial/checkin/reminder。2 与 3、4 无互相 SQL 依赖，但正式 test 必须一次一个文件按 1→2→3→4。文件 1 与 3 之间不要创建 VIP 订单；文件 3 会回补窗口期内 credits 的 `fulfillment_applied`。
  - 对象归属：`vip_memberships` / `vip_purchase_grants` / `feature_free_trials` / `wallet_refunds` / payment 快照列 / ledger `vip_bonus`+`debit_key` → `billing`；`notifications` 新列与 reminder RPC / 签到扩展 → `miniapp_features`；`vip_entry_seen_at` → `app_core.miniapp_user_settings`。
  - 复用/扩展：`grant_bonus_credits`（月卡 3000）；`complete_payment_order(text,text,text default null)` 同签名扩展；`claim_daily_checkin` 加用户锁与可读 VIP，不改金额。不复用 `charge_llm_usage` / `charge_voice_usage` / `settle_image_generation` 作为 VIP 扣款实现。
  - 权限：新 billing 表 RLS on、零 policy、anon/authenticated 无表权限。新 RPC 与扩展后的 `complete_payment_order`：DEFINER + `search_path=pg_catalog`，REVOKE PUBLIC/anon/authenticated，仅 postgres/service_role。`claim_daily_checkin` 保持历史 PUBLIC/anon/authenticated EXECUTE。
  - 本地验证（真实结果）：
    - `pnpm lint:migrations` pass
    - `pnpm lint:legacy` pass
    - `pnpm test:migration-ledger` pass
    - `bash scripts/test-vip-billing-migrations.sh` pass（含并发 debit、两张 VIP 续费、免费次数争用、迟到 consume 自动回收）
    - `pnpm --filter @miniapp/shared test` 10 files / 88 tests pass
    - `pnpm --filter @miniapp/shared typecheck` pass
    - `pnpm -r typecheck` shared/admin/backend/frontend/cs-platform pass
  - 未能在本地等同 test 远端验证：215 行 `payment_orders` 加列锁时延、PostgREST reload、四路微信支付重放、anon JWT 实打、Production 结构。
  - test apply 前置：confirm MCP/workflow 目标仍是 `zoqelpfhurwehlvypryl`；账本无这 4 个 filename；VIP 表仍不存在；停购 VIP；文件 1 后旧 RPC 仍可完成 credits。
  - 停止条件：未获明确批准不得跑 `.github/workflows/db-migrate.yml`。T2 保持 Doing。已售 VIP 后禁止 down migration，改 forward-fix。Production 结构/签到/价格仍未核。
- 2026-09-22 T2 远端验证完成，T2 → Done。MCP 目标仍是 `https://zoqelpfhurwehlvypryl.supabase.co`。inspect 四文件均为 `match / applied`。只读 catalog，未读业务明细，未写 Production，未进 T3。
  - 账本：`20260921_vip_billing_schema.sql`、`wallet_debit_refund.sql`、`vip_payment_fulfillment.sql`、`feature_free_trial_checkin_reminder.sql` 均为 applied。apply 实序为 1 → 3 → 2 → 4；2/3 无互相 SQL 依赖，未因此失败。
  - 对象：四张 VIP 表、`product_type`/`debit_key`/`business_key`/`vip_entry_seen_at`、全部规划 RPC 均存在；两参 `complete_payment_order` 仍不存在；无 `pg_cron`。
  - 权限：新表 RLS on、零 policy、anon/authenticated 无 SELECT/INSERT。新 RPC 与扩展后的 `complete_payment_order`：DEFINER、`search_path=pg_catalog`、anon/authenticated EXECUTE=false、service_role=true。`claim_daily_checkin` 仍保留历史 anon/authenticated EXECUTE。
  - 守恒/开关：wallets=31 且 `main+bonus=total`；credits 订单 `fulfillment_applied=credits_added` 错位数=0；非 credits 订单=0；签到配置仍=40；`vip_purchase_enabled`/`vip_reminders_enabled` 均为 false。
  - 仍未在 test 用真实四路微信支付重放；并发幂等以本地 throwaway Postgres 为准。Production 结构仍未核。
- 2026-09-22 T3 开始：分支 `dev_vip_0920`。父任务 `in_progress`。T0/T1/T2 Done，T3 → Doing。未重复 `task.py start`。未改 T1/T2 已完成 migration 与契约语义，未进 T4，未启动媒体子任务，未写 test/production，未 commit/push。复用核验见 `research/t3-backend-reuse.md`。
- 2026-09-22 T3 本地实现完成，**停在 test apply 前，T3 保持 Doing**。未触发 GitHub Actions，未通过 MCP/SQL 写正式 test，未写 Production，未启用 `vip_purchase_enabled` / `vip_reminders_enabled`，未进 T4，未启动媒体子任务，未 commit/push。
  - 签到权威入口：`app_core.runtime_config.miniapp_daily_checkin_bonus_credits`。test 实值仍是 40。T2 函数把 `vip_reward_credits` 固定为 0。新文件 `packages/shared/migrations/20260922_daily_checkin_vip_bonus.sql` 把该 key 写成 60，并在同一 `now()` 下按 `valid_until > now()` 加同等基础额。缺失配置兜底从 10 改为 60。历史 anon EXECUTE 保持。
  - 邀请首付：已批准 forward-fix。`20260922_invite_first_paid_vip_fulfillment.sql` 让 `fulfillment_applied` 的 VIP 订单计入首次现金支付；非 VIP 仍认 `credits_added`。同一订单重放不二次发奖。不改 109，不改奖励金额和开关。本地场景已通过。正式 test 尚未 apply。
  - Backend：`features/vip`、`MiniappVipRepository`、`GET /api/vip/status`、`POST /api/vip/entry-viewed`。支付快照与四路 `settlePaidOrder` → 已部署的 `complete_payment_order`。钱包 `credits = total = main + bonus`。签到响应映射 RPC 的 base/vip/total。
  - 本地验证：
    - `pnpm --filter @miniapp/backend test` → 55 files / 480 tests passed
    - `pnpm --filter @miniapp/backend typecheck` → pass（含在 `pnpm -r typecheck`）
    - `pnpm --filter @miniapp/shared test` → 10 files / 88 tests passed
    - `pnpm --filter @miniapp/shared typecheck` → pass
    - `pnpm -r typecheck` → shared/admin/backend/frontend/cs-platform pass
    - `pnpm lint:imports` / `pnpm lint:legacy` / `pnpm lint:migrations` → pass
    - `pnpm test:migration-ledger` → pass
    - `bash scripts/test-vip-billing-migrations.sh` → pass（含 T2 场景、新 migration、普通/VIP/临界签到、两次并发只入账一次）
  - 未做：正式 test apply 与只读 postflight；真实微信支付；Production 签到值采集。
  - 新 migration apply 顺序：已有 T2 四文件之后，单独 apply `20260922_daily_checkin_vip_bonus.sql`。Backend 必须在该文件 apply 并复核之后再发布，否则预览会按 60/120 计算而线上 RPC 仍是 40 且 VIP 加成为 0。
- 2026-09-22 T3 远端复核完成，T3 → Done。MCP 目标仍是 `https://zoqelpfhurwehlvypryl.supabase.co`。只读配置与函数目录，未读业务行，未写 Production，未进 T4，未启动子任务，未改功能开关。
  - 账本 checksum 与本地文件一致且均为 applied：`20260922_daily_checkin_vip_bonus.sql` = `bd1168500f8e70587693ee28a7e6c3d7f1cf0bf0da91fd0160453d1d0c21e875`；`20260922_invite_first_paid_vip_fulfillment.sql` = `4b42cc04be536392a4c5ccc35c3e53c064f14a098f0e2531fdf76cc0ba48cf11`。
  - 签到配置值 = 60。`claim_daily_checkin(uuid)` 含 VIP 加成、`search_path=pg_catalog`、service_role 可执行；历史 anon/authenticated EXECUTE 仍在。
  - `check_invite_first_paid_reward(uuid,text)` 含 `fulfillment_applied`、`search_path=pg_catalog`；anon/authenticated 不可执行，service_role 可执行。
  - `complete_payment_order(text,text,text)` 仍含履约标志且 anon 不可执行。`vip_purchase_enabled` 与 `vip_reminders_enabled` 均为 false。
  - 未在 test 用真实四路微信支付重放。Production 结构与签到值仍未核。`20260912_backfill_character_persona_and_style.sql` 与 `20260914_chat_message_images*.sql` 仍 absent，不属于本任务。
- 2026-09-21：产品将三档文本模型折扣从 88 折改为 95 折。已同步 PRD/design/implement/task、校验清单、T0 research，以及 T1 契约常量 `VIP_TEXT_DISCOUNT_RATE = 0.95` 与对应测试期望（15→14、30→29、50→48）。月卡 28.88 元未改。
- 后续执行时每完成一个 Task，补充实际文件、命令、结果、失败路径、环境和剩余风险；不得只改 Status。

## T1 冻结给 T2 的公共契约

T2 只做 migration/RPC，必须使用这些名字，不得改语义。Producer（T3/T4）再写入 DTO；T1 为兼容把现有响应上的新字段做成可选。

### 枚举与常量

- `VipPlanId`: `'week' | 'month'`
- 周卡：`price_cents=1399`，`duration_days=7`，`bonus_credits=0`
- 月卡：`price_cents=2888`，`duration_days=31`，`bonus_credits=3000`
- `PaymentProductType`: `'credits' | 'vip'`
- `WalletDebitPolicy`: `'main_only' | 'main_then_bonus'`
- `BillableCapability`: `'text_light' | 'text_standard' | 'text_premium' | 'image_basic' | 'image_advanced' | 'voice'`
- `FeatureFreeTrialFeature`: `'voice' | 'basic_image'`
- `FeatureFreeTrialStatus`: `'reserved' | 'consumed' | 'released'`
- `FEATURE_FREE_TRIAL_LIMIT = 3`
- `VIP_TEXT_DISCOUNT_RATE = 0.95`
- `VIP_EXPIRY_NOTIFICATION_KIND = 'vip_expiry'`
- `VipReminderWindow`: `'expiring_soon' | 'expires_today'`
- `ImageGenerationTier`: `'basic' | 'advanced'`（类型已冻结；图片请求字段由图片子任务接入）

### 错误码

- 门禁：`VIP_REQUIRED`、`MAIN_CREDITS_INSUFFICIENT`、`TOTAL_CREDITS_INSUFFICIENT`、`FEATURE_FREE_TRIAL_EXHAUSTED`、`ADVANCED_IMAGE_UNAVAILABLE`
- 免费次数：`FEATURE_FREE_TRIAL_EXHAUSTED`、`FEATURE_FREE_TRIAL_CONFLICT`、`FEATURE_FREE_TRIAL_INVALID_STATE`
- 钱包拆分：`INVALID_AMOUNT`、`INVALID_WALLET_SPLIT`、`UNSUPPORTED_WALLET_POLICY`、`MAIN_CREDITS_INSUFFICIENT`、`TOTAL_CREDITS_INSUFFICIENT`
- 旧裸 402 `insufficient_balance` 保留，不得删除或改成新码

### 关键 DTO 字段

- `VipStatus`: `active`、`valid_from`、`valid_until`、`remaining_days`、`last_plan_id`、`entry_badge_visible`
- 权限只认 `valid_until > now()`；`remaining_days` 仅展示，用 `remainingVipDisplayDays` 对正剩余毫秒向上取整
- `PaymentOrder` 可选快照：`product_type`、`product_id`、`fulfillment_applied`、`vip_duration_days`、`vip_bonus_credits`、`vip_valid_until`
- `GetPaymentPlansData.vip_plans?: VipPlan[]`；`plans` 仍是星尘套餐
- 钱包：`main_credits` 充值、`bonus_credits` 专项、`total_credits = main + bonus`；`credits` 继续等于 `total_credits`
- 流水可选：`main_delta`、`bonus_delta`、`original_amount`、`discount_rate`、`refund_of`、`source_label`
- 签到可选：`base_reward_credits`、`vip_reward_credits`；`reward_credits` 仍是总数
- 通知可选：`kind`、`action_path`、`metadata`（VIP 到期 metadata：`reminder_window` + `observed_valid_until`）
- 新增 `GetNotificationDetailData`、`GetVipStatusData`/`MarkVipEntryViewedData`（均为 `VipStatus`）

### 纯函数签名（T2/T4 必须复用，禁止平行实现）

```ts
quoteTextModelUsage({ original_credits, is_vip, is_free_round, tier }): QuoteTextModelUsageResult
roundHalfUpToInteger(value: number): number
resolveBillableCapabilityRules(capability: BillableCapability): BillableCapabilityRules
assertWalletPolicyForCapability(capability, policy)
createWalletAmountSplit(mainCredits, bonusCredits, totalCredits?)
allocateWalletDebit({ policy, amount, main_credits, bonus_credits, debit_key })
allocateWalletRefund({ original_debit, refund_key, debit_key })
summarizeFeatureFreeTrialQuota({ feature, facts })
isVipPlanId(planId): planId is VipPlanId
paymentProductTypeForPlanId(planId): 'vip' | null
isVipActiveAt(validUntil, now): boolean
remainingVipDisplayDays(validUntil, now): number
```

能力矩阵（T2 RPC 必须一致）：

- light 文本：`main_then_bonus`，不要求 VIP
- standard/premium 文本：`main_only`，要求 VIP
- basic image / voice 付费：`main_only`，不要求 VIP，免费次数 3（失败=released 不占 used）
- advanced image：`main_only`，要求 VIP，无免费次数
- 组合扣与退款必须 `main + bonus = total`；余额不足整笔失败，不得部分扣款
- 退款按原始 debit 拆分原路返回，并用 `debit_key` / `refund_key` 做幂等关联
