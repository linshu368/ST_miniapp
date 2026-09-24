# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                           | Files / Scope                                        | Depends On                            | Verification                                     |
| --- | ------ | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| T0  | Done   | 完成人工评审、test 环境与高级图片配置确认                      | task docs / env inventory                            | -                                     | 评审结论与环境证据齐全，满足停止条件检查         |
| T1  | Done   | 定义 VIP、支付、钱包、模型、通知及媒体免费公共契约与价格纯函数 | `packages/shared/src/api/*`                          | T0                                    | shared test/typecheck；旧字段兼容                |
| T2  | Done   | 添加会员/钱包/免费额度公共结构、RLS/grants、索引与原子 RPC     | `packages/shared/migrations/*`                       | T1                                    | test 单文件 migration、自检、守恒/并发/回滚演练  |
| T3  | Done   | 实现 VIP status、商品下单、支付原子履约与签到加成              | Backend VIP/payment/wallet routes + repositories     | T2                                    | 四路支付、续费、月卡赠送、60/120 与故障测试      |
| T3A | Done   | 新增 Admin“VIP策略”与动态商品/权益配置 forward-fix             | Shared + DB + Backend + Admin                        | T3                                    | 配置校验、快照、回滚、旧版本兼容、Admin build    |
| T4  | Done   | 改造 LLM 权限、折扣、钱包分配、明细与原路退款                  | Backend models/generation/billing/wallet             | T2,T3                                 | 钱包矩阵、配置快照、并发、重放、退款回归测试     |
| T5  | Done   | 向语音/图片子任务交付底座并完成跨模块集成验收                  | 两个 child task + parent integration                 | 语音/图片底座等 T2/T3；动态上限等 T3A | 子任务证据、免费/钱包/权限联合矩阵               |
| T6  | Done   | 实现 VIP 到期提醒、单条已读和消息详情 API                      | Backend reminder/notifications + Railway test config | T2,T3,T3A                             | 时间窗口、续费竞态、去重、越权和 dry-run 验证    |
| T7  | Done   | 更新我的页、VIP/充值、聊天模型、媒体与消息 UI                  | Frontend pages/components/hooks                      | T1,T3,T3A,T4,T5,T6                    | 前端 test/lint/typecheck/build + 人工状态矩阵    |
| T8  | Done   | 完成跨包回归、test 必验路径、文档与模块知识更新                | 全仓、README、ARCHITECTURE、spec/module facts        | T1-T7                                 | 全量命令、test 证据、`module_knowledge.py check` |
| T9  | Todo   | 形成 Production 发布单并等待产品上线确认                       | migrations / Railway / feature flags                 | T8                                    | 未获明确确认保持 Production 关闭                 |

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
- 2026-09-22 新增需求：Admin 新建“VIP策略”tab，纳管 VIP 购买开关、提醒开关、周/月卡价格与有效天数、月卡赠送专项星尘、文本折扣率、商品标题/说明/角标、签到加成方式/固定值、语音与 basic 图片各自免费次数。首次 seed 保持当前规则；到期提醒提前天数/文案/时区不进 Admin，语音价格/开关/提示与高级图片配置本次不纳入。新增 T3A；T2/T3 已 apply，后续只允许 forward-fix migration，不改历史文件。动态免费次数统一为 `0..20`，默认 3，0 表示关闭对应功能的免费体验。
- 2026-09-22 T4 开始：分支 `dev_vip_0920`，HEAD `2f2eb0e`，与 `origin/dev_vip_0920` 一致，工作区干净。父任务已是 `in_progress`。T0–T3 Done，T4 → Doing。未重复 `task.py start`（本会话无 session identity）。未改语音/图片子任务，未进 T5，未写 test/production，未 commit/push。复用、失败路径、迁移兼容和验证计划见 `research/t4-llm-billing-reuse.md`。
- 2026-09-22 T4 本地实现完成，**停在 test apply 前，T4 保持 Doing**。未触发 GitHub Actions，未通过 MCP/SQL 写正式 test，未写 Production，未启用购买/提醒/高级图片，未进 T5，未改语音/图片实现，未 commit/push。
  - 报价与资格：`quoteTextModelUsage`。原价来自 `getPricingConfig()`。免费轮实付 0。VIP 三档按运行时原价 × 0.95 四舍五入。标准/旗舰要有效 VIP；到期后 config 与生成都回落轻量，写回失败不阻断本轮。选择接口拒绝并返回 `VIP_REQUIRED`，不改已保存选择。
  - 钱包：轻量 `main_then_bonus`，标准/旗舰 `main_only`。402 的可用余额按策略计算。目录 GET 不因余额不足返回 402。
  - 受理快照写入 `fixed_deduction` 与原价/折扣/策略/VIP 截止时间。`charge_llm_usage` 优先读已落库的 `payable_credits`，再读 `fixed_deduction`。sync 重放同一快照。余额不足整笔回滚，不写新 partial；历史 partial 只读返回。
  - 补偿入口：`compensateDebitedLlmCharge` → `billing.refund_llm_usage_charge` → `refund_wallet_debit`。charge 行保持 `charged`，metadata.`compensation_status=refunded`。没有 `debit_key` 的历史扣款返回 `not_refundable`，不改余额。history 写失败不自动退款，sync 按 `charge_key` 重放。
  - 新 migration：`packages/shared/migrations/20260922_llm_vip_wallet_charge.sql`。只替换 `billing.charge_llm_usage` 并新增 `billing.refund_llm_usage_charge`。不改 T2/T3 文件，不新建表。本地 sha256 `99f63f2e523eb72ca66db12a0ec519973f4ac42b113d36de405a3d3c42f87241`。
  - 发布顺序：该文件 apply 并复核之后才能发布 Backend。先发 Backend 时，旧函数仍会 bonus 优先且允许 partial，并忽略 wallet policy。
  - 降级目录：运行时目录损坏而落到内置 `DEFAULT_CATALOG` 时没有轻量档。非 VIP 的标准/旗舰会失败关闭，不会用旗舰顶上。
  - 本地验证：
    - `bash scripts/test-vip-billing-migrations.sh` → pass（含 T2/T3、T4 免费/只有 bonus/main-only 拒绝/组合扣/快照不被 999 改写/pending 竞态不 partial/历史 partial 只读/无 debit_key 不退款/原路退款与重复退款，以及并发 charge 只入账一次）
    - `pnpm --filter @miniapp/backend test` → 57 files / 498 tests passed。并行 typecheck 时曾有 6 个 route 用例 5s 超时；单独重跑 telemetry/vip/payment 47 tests passed，随后全量再跑通过。
    - `pnpm --filter @miniapp/shared test` → 10 files / 88 tests passed
    - `pnpm -r typecheck` → shared/admin/backend/frontend/cs-platform pass
    - `pnpm --filter @miniapp/backend typecheck` → pass
    - `pnpm lint:imports` / `pnpm lint:legacy` / `pnpm lint:migrations` → pass
    - `pnpm test:migration-ledger` → pass（需本机 Postgres；沙箱里 socket 被拒，退出沙箱后通过）
  - 未做：正式 test apply 与 apply 后的只读 postflight；真实 OpenRouter/SSE；Production。
- 2026-09-22 T4 test apply 复核通过。用户提供的 inspect 账本中 `20260922_llm_vip_wallet_charge.sql` checksum `99f63f2e523eb72ca66db12a0ec519973f4ac42b113d36de405a3d3c42f87241` 与本地文件一致，verdict 为 `match / applied`。MCP 目标 `https://zoqelpfhurwehlvypryl.supabase.co`。只读函数目录，未读业务行，未写 Production。
  - `billing.charge_llm_usage`：SECURITY DEFINER，`search_path=pg_catalog`，调用 `apply_wallet_debit`；anon/authenticated 不可执行，service_role 可执行。
  - `billing.refund_llm_usage_charge`：SECURITY DEFINER，`search_path=pg_catalog`，调用 `refund_wallet_debit`；anon/authenticated 不可执行，service_role 可执行。
  - `vip_purchase_enabled` 与 `vip_reminders_enabled` 仍为 false。
  - 当时未标 Done：任务表曾要求 T4 在完成验收前接入 T3A 的已发布折扣配置；已推送的文本计价使用冻结的 0.95 默认。2026-09-23 用户确认 T4 按原范围完成，动态配置改由 T3A additive 接入，见后续日志。真实 OpenRouter/SSE 与 Production 仍未验。
  - 给 T5 合并核对的共享文件：`MiniappWalletRepository.ts`（只加 LLM 退款 RPC 与消费明细字段，语音扣费签名未改）、`scripts/test-vip-billing-migrations.sh`、`features/generation` 下文本计费文件（未改 image）、`ConversationHistoryRepository.ts` 的可选快照字段、`routes/models.ts`、`routes/conversations.ts`、`features/conversations/generate.ts`、`MiniappUserSettingsRepository.ts` 的 `correctSelectedModelId`。未改 `packages/shared/src/index.ts`，未改语音/图片实现。
- 2026-09-23 规划收口：用户确认 T4 已由 commit `5f4ee24` 完成交付，T4 → Done；运行时动态折扣不再作为 T4 完成条件，由 T3A additive 接入。T3A → Doing，免费次数范围冻结为 voice/basic_image 各 `0..20`、默认 3、0 表示关闭。本次仅收口 PRD/design/implement/task/manifests/research，未写产品代码，未 apply 新 migration，未写 test/Production，未进入 T5；规划独立提交且不 push。
- 2026-09-23 T3A 本地实现完成，**停在 test apply 前，T3A 保持 Doing**。分支 `dev_vip_0920`。父任务已是 `in_progress`，未重复 `task.py start`。未写 test/Production，未启用购买/提醒开关，未进 T5/T6，未改语音/图片子任务状态，未 commit/push。
  - 复用：Admin managed-key 草稿/发布/回滚、`fetchRuntimeConfigEntries`、`quoteTextModelUsage`、`complete_payment_order(text,text,text)`、`claim_daily_checkin(uuid)`、`reserve_feature_free_trial(uuid,text,text,integer)`。不新增直写 `runtime_config` 的旁路，不新建设通用配置框架。
  - 商品快照边界：已应用的订单 CHECK 和履约函数把周卡/月卡钉死在 1399/7/0 与 2888/31/3000。新文件只放宽为与 Shared 相同的范围，履约仍只读订单行，不读当前 `vip_plans_config`。三个 RPC 签名不变。
  - 新 migration：`packages/shared/migrations/20260923_vip_strategy_config.sql`。sha256 `ad877b4c660d3d92886b1786bd5230720fb2310db23bc0227f223c5a4038c084`。seed 保持购买/提醒 false、周卡 1399 分/7 天/0、月卡 2888 分/31 天/3000、折扣 0.95、签到 `same_as_base`、免费次数各 3。ordinal CHECK 改为 1..20。本地 harness 额外文件 `fixtures/vip_strategy_admin_harness.sql` 禁止 apply 到 test/Production。
  - 发布顺序：该文件 apply 并复核之后再发 Backend/Admin。先发 Backend 时，缺失的新 key 会按安全默认工作并打告警；购买/提醒已存在且保持 false。
  - 实际文件：
    - Shared：`packages/shared/src/api/vip-strategy.ts`、`vip.ts`、`feature-free-trials.ts`、`models.ts`、`index.ts` 及对应测试
    - DB：上述 migration、`tests/vip_strategy_t3a_scenarios.sql`、`scripts/test-vip-billing-migrations.sh`、`scripts/check-legacy-references.mjs`（同一 `complete_payment_order` 函数体）
    - Backend：`platform/vip-strategy.ts`；订单快照、文本折扣快照、签到预览、模型目录/选择读取已发布策略
    - Admin：`VipStrategyView.tsx`、`vipStrategyForm.ts`、导航「VIP策略」、managed schema
  - 验证（本地，真实结果）：
    - `bash scripts/test-vip-billing-migrations.sh` → pass。覆盖非法发布值、缺失上限回退 3、0/4/20、调高调低后历史行保留、重放、并发上限 4、签到 same_as_base/fixed/损坏回退、改价后新旧订单快照、配置改回后订单/grant/签到/免费事实不变。脚本里并发签到输家的 `daily check-in is not ready` 是原有预期错误，最终计数通过。
    - `pnpm --filter @miniapp/shared test` → 11 files / 93 tests passed
    - `pnpm --filter @miniapp/shared typecheck` → pass
    - `pnpm --filter @miniapp/backend test` → 58 files / 504 tests passed
    - `pnpm --filter @miniapp/backend typecheck` → pass
    - `pnpm --filter @miniapp/admin test` → 9 files / 52 tests passed
    - `pnpm --filter @miniapp/admin typecheck` → pass
    - `pnpm --filter @miniapp/admin build` → pass
    - `pnpm -r typecheck` → shared/admin/backend/frontend/cs-platform pass
    - `pnpm lint:imports` / `pnpm lint:legacy` / `pnpm lint:migrations` → pass
    - `pnpm test:migration-ledger` → pass（本机 Postgres；未连 test/Production）
  - 未做：正式 test apply 与 apply 后只读 postflight；Admin 登录后的页面点击（运营台需要已登录会话，本轮不连 test）；旧 Backend 进程对新库的实跑（兼容结论来自 RPC 签名不变和 seed/缺失时的默认行为）；Production。
  - 剩余风险：test 上 `payment_orders` / `vip_purchase_grants` / `feature_free_trials` 的 CHECK 替换会锁表并重验已有行；Admin 在 migration apply 前发布新 key 会被数据库拒绝。
- 2026-09-23 T3A 首次 test apply 失败并整段回滚，T3A 仍为 Doing。GitHub Actions 在 `feature_free_trials ordinal check missing` 处退出。test 目录里的序号 CHECK 已是 `ordinal <= 100`，查找条件仍要求字面量 `3`，因此找不到约束。`payment_orders_product_snapshot_check` 仍含 1399，账本未记录该文件。只读聚合：免费事实 5 行，ordinal 最小 1、最大 3，没有大于 20 的行。已改为按列名删除现有序号 CHECK，再添加 1..20。本地 `bash scripts/test-vip-billing-migrations.sh` 再次通过。未再次 apply test。
- 2026-09-23 T3A test apply 与只读 postflight 完成，T3A → Done。MCP 目标 `https://zoqelpfhurwehlvypryl.supabase.co`。用户提供的 inspect 中 `20260923_vip_strategy_config.sql` checksum `7fe41b2b435c4cb33305c77acab720aee593105e167db46b23d99ef32ced5f3d` 与本地文件一致，verdict 为 `match / applied`。未读业务明细，未写 Production，未进 T5。
  - 六个配置均等于首次 seed：购买/提醒为 false；折扣 0.95；签到 `same_as_base`；voice/basic_image 均为 3；周卡 1399 分/7 天/0 赠送，月卡 2888 分/31 天/3000。
  - `feature_free_trials_ordinal_check` 为 `ordinal >= 1 AND ordinal <= 20`。订单与 purchase grant 的 CHECK 不再钉死 1399。草稿/发布白名单包含六个 VIP key，并保留 test 上已有的高级图片 key。
  - `reserve_feature_free_trial(uuid,text,text,integer)`、`claim_daily_checkin(uuid)`、`complete_payment_order(text,text,text)` 均为 SECURITY DEFINER 且 `search_path=pg_catalog`。reserve 读取 `feature_free_trial_limits`，anon 不可执行，service_role 可执行。claim 读取 `vip_checkin_bonus_config`，并保留 anon/authenticated/service_role EXECUTE。complete_payment_order 不再含 `<> 1399`，anon 不可执行，service_role 可执行。
  - 仍未在 test 用真实订单、签到或免费额度重放；并发与快照以本地 throwaway Postgres 为准。Admin「VIP策略」页未在已登录会话里点击。旧 Backend 进程未对新库实跑。Production 未核。
- 2026-09-23 T6 开始：分支 `dev_vip_0920`。HEAD `b24fc6a`（`778fb2f` 的子提交，多出的是已随 T3A apply 的序号约束修复）。父任务已是 `in_progress`，未重复 `task.py start`。T5 保持 Todo，未改语音/图片子任务。T6 → Doing。本轮只做本地实现，不写 test/Production，不启用提醒开关，不配置 Production Cron，不进 T7，不 commit/push。
  - 复用：T2 的 `notifications.kind/business_key/action_path/metadata`、`uq_notifications_business_key`、`miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)`，以及 `idx_vip_memberships_valid_until`。履约函数已经 `FOR UPDATE` 同一会员行。不新建表，不改历史 migration，不覆盖 `20260923_vip_strategy_config.sql`。
  - 边界：T6 提供详情 API 和通知契约；消息详情页、卡片和续费按钮 UI 留给 T7。详情不内嵌 VIP 状态，当前状态继续走 `GET /api/vip/status`，避免续费改写历史正文。
  - 环境：不连接 test/Production 做写入。正式 test migration apply、只读 postflight、test dry-run 和受控写入完成前，T6 保持 Doing。
- 2026-09-23 T6 本地实现完成，**停在 test apply 前，T6 保持 Doing**。未触发 GitHub Actions，未通过 MCP/SQL 写正式 test，未写 Production，未把 `vip_reminders_enabled` 改成 true，未 `railway config apply`，未进 T5/T7，未改语音/图片子任务，未 commit/push。
  - 复用决定：继续用 T2 的通知列、`uq_notifications_business_key` 和六参 `insert_vip_expiry_reminder`。新 migration 只增加窗口函数、有界候选列表和 `insert_due_vip_expiry_reminder(uuid)`，并让六参函数在 `FOR UPDATE` 之后按锁定的 `valid_until` 重算上海窗口。幂等键仍是 `user_id + observed_valid_until + reminder_kind`，不含执行时间。
  - 对象：函数在 `miniapp_features`，读取 `billing.vip_memberships`，写入 `miniapp_features.notifications`。不新建表。SECURITY DEFINER 是因为两张表 RLS 开启且没有 anon policy，函数必须在表主权限下加锁写入。`search_path=pg_catalog`。PUBLIC/anon/authenticated 不可执行。单批上限 100，语句超时 5s。
  - 脚本：`packages/backend/src/scripts/send-vip-expiry-reminders.ts`。无参数或 `--dry-run` 只计数。`--write` 只有在 `vip_reminders_enabled` 的 JSON 值恰好为 true 时才调用插入。缺失、false、非法值和读取异常都不写；读取异常记 `{ err }` 且不扫描。Railway development Cron `stminiapp-vip-reminder-cron` 为 `20 * * * *`，启动命令带 `--dry-run`。production 的 IaC 不声明该服务。
  - 通知 API：列表不写已读。`POST /api/notifications/read` 必须带具体 `ids`，只传 `scope` 返回 400。`GET /api/notifications/:id` 对他人定向、未发布、已删除和未知 id 都返回同一个 404。详情不含实时 VIP 状态，当前状态仍走 `GET /api/vip/status`。
  - 新 migration：`packages/shared/migrations/20260923_vip_expiry_reminder_dispatch.sql`。sha256 `364b17c747204cb02d61e381cf7a46f8a1148f84f9c5d9f4a1c540bb17760eb6`。
  - 实际文件：上述 migration 与 `tests/vip_reminder_t6_scenarios.sql`；`scripts/test-vip-billing-migrations.sh`；`packages/backend/src/features/vip/vip-expiry-reminder.ts` 及测试；提醒脚本；`routes/notifications.ts` 及测试；`platform/runtime-config.ts` 的严格读取；`packages/shared/src/api/notifications.ts`；`.railway/railway.ts`；`docs/ARCHITECTURE.md`；`ops/railway/README.md`。
  - 验证（本地，真实结果）：
    - `bash scripts/test-vip-billing-migrations.sh` → pass。覆盖上海 3 天/当天、2 天/4 天/已过期、UTC 跨日、闰日、月末、年末、冬夏偏移仍为 +08、会话时区不影响窗口、同周期重跑、新旧周期各一条、已发送正文在续费后不变、未发送旧周期被跳过、批次上限与游标、limit 0/101 拒绝、重放 migration 被拒绝、两个会话并发只插入一行、续费先持锁得到 `skipped_window` 且 0 行、提醒先持锁写入「VIP 即将到期」后会员仍可被续费。并发签到输家的 `daily check-in is not ready` 仍是原有预期错误。
    - `pnpm --filter @miniapp/shared test` → 11 files / 94 tests passed
    - `pnpm --filter @miniapp/shared typecheck` → pass
    - `pnpm --filter @miniapp/backend test` → 60 files / 520 tests passed
    - `pnpm --filter @miniapp/backend typecheck` → pass
    - `pnpm -r typecheck` → shared/admin/backend/frontend/cs-platform pass
    - `pnpm lint:imports` → pass
    - `pnpm lint:legacy` → pass
    - `pnpm lint:migrations` → pass
    - `pnpm test:migration-ledger` → pass（本机 Postgres；未连 test/Production）
  - 未做：正式 test apply 与只读 postflight；对 test 库的 dry-run；受控写入；`railway config apply`；Production Cron 与 Production 开关。语句超时的脚本重试用模拟的 `57014` 锁定，没有在活库里取消一条真实查询。
  - 剩余风险：当前前端打开消息列表仍会只提交 `scope`，新 API 会返回 400，红点要等 T7 改为提交单条 id 后才会清除。函数替换会短暂锁函数定义，不改业务行。旧 Backend 不调用新 RPC；六参签名仍在。
- 2026-09-23 T6 test inspect 完成，T6 仍为 Doing。用户提供的 Database Migration inspect 目标是 test `zoqelpfhurwehlvypryl`。`20260923_vip_expiry_reminder_dispatch.sql` checksum `364b17c747204cb02d61e381cf7a46f8a1148f84f9c5d9f4a1c540bb17760eb6` 与本地文件一致，verdict 为 `match / applied`。全表 drift=0。未读业务行，未写 Production，未跑 test dry-run，未打开 `vip_reminders_enabled`。
  - 该文件在事务末尾自带 postflight，失败会整段回滚，因此账本记为 applied 说明 apply 当时函数、`search_path`、DEFINER 和 anon/authenticated 不可执行这些检查已经通过。
  - 本会话没有 Supabase MCP，不能把 apply 当时的检查写成当前目录实况。dry-run 前还要补一次只读目录核对。
  - inspect 里另有 13 个 `not_applied`，包括 batch lab、`20260922_media_feature_free_trials.sql` 和 `20260923_admin_vip_media_config.sql`。它们不属于 T6，本轮不 apply。
- 2026-09-23 T6 test 只读 postflight 通过，T6 仍为 Doing。用户在 test SQL Editor 执行目录查询，未读业务明细。结果：`insert_due_vip_expiry_reminder(uuid)`、`list_vip_expiry_reminder_candidates(integer,uuid)`、六参 `insert_vip_expiry_reminder` 均存在；anon/authenticated 对 due 与 list 的 EXECUTE 均为 false；service_role 均为 true；两个新函数都是 SECURITY DEFINER 且 `search_path=pg_catalog`；`uq_notifications_business_key` 存在；`vip_reminders_enabled` 仍为 false。未跑 test dry-run，未 `--write`，未打开开关，未写 Production。
- 2026-09-23 T6 test dry-run 完成，T6 仍为 Doing。`pnpm --filter` 会把 `--` 原样传给脚本，解析器原先把它当成非法参数。已让 `parseVipReminderArgs` 忽略单独的 `--`。`DATABASE_ENV=test`，项目 `zoqelpfhurwehlvypryl`。命令 `pnpm --filter @miniapp/backend vip:send-expiry-reminders -- --dry-run` 结果：`{"scanned":0,"eligible":0,"inserted":0,"skipped":0,"failed":0,"dry_run":true,"duration":643}`。当前没有落在上海今天或今天+3 天窗口内、且尚未发送的会员，所以计数为 0；没有调用插入。未打开 `vip_reminders_enabled`，未 `railway config apply`，未写 Production。参数修复随这次提交推送。随后按授权对 test 执行 `--write`，开关保持 false。
- 2026-09-23 T6 受控写入校验通过，T6 → Done。授权仅限 `--write`，没有把 `vip_reminders_enabled` 改为 true。`DATABASE_ENV=test`，项目 `zoqelpfhurwehlvypryl`。命令 `pnpm --filter @miniapp/backend vip:send-expiry-reminders -- --write`。日志 `vip.reminder.write_blocked`，reason=`disabled`。结果：`{"scanned":0,"eligible":0,"inserted":0,"skipped":0,"failed":0,"dry_run":false,"duration":1429}`。开关关闭时写模式不插入。未 `railway config apply`，未配置 Production Cron，未写 Production。真实发送仍关闭；今天也没有落在提醒窗口内的会员，因此这次不能证明一条真实站内信。
- 2026-09-23 T5 开始，保持 Doing。独立 worktree `/Users/qj/python_project/ST_miniAPP_vip_t5`，分支 `task/vip-t5-integration`，HEAD `0c05afb342e00bb79eae2e2a20d0f27c7cb48367`（squash `Feat vip voice image (#344)`，父提交 `b24fc6a`）。未在 T6 工作区 `/Users/qj/python_project/ST_miniAPP` 做 checkout/reset/stash/merge。未重复 `task.py start`。未进 T7。未写 test/Production，未 apply migration，未开功能开关，未 commit/push。
  - 合入核验：squash 的 tree 与 `feat_vip_voice_image` 尖端 `ac8967a` 相同。语音交付 `c9872ba`、图片交付 `8f63e0d`、媒体 migration `5059ad2` 都在该尖端历史上，因此代码在当前树里；它们不是 squash 的祖先。父任务 T4 `5f4ee24`、T3A `778fb2f`、序号修复 `b24fc6a` 是 HEAD 祖先。`feature_free_trial_limits` 契约已在树里。子任务 `task.md` 在本基线已是 Done，本轮没有改子任务状态。
  - 基线同时带入 `dev` 上的 batch-lab 等非媒体差异。T6 提交 `2f3892b` 建在 `b24fc6a` 上，不在本分支历史里。
  - 集成缺陷：语音/图片展示额度读 `media_feature_free_trial_limit`（单一 1..100），预留函数在 T3A 中读 `feature_free_trial_limits`（voice/basic_image 各 0..20）。`quota`/`emptyFreeTrialQuota` 用 1..100 解析，把 0 抬回 3。`20260923_admin_vip_media_config.sql` 若在已应用的 T3A 之后执行，会换掉 reserve 与 admin 校验，并把序号放宽到 100；体验表序号约束仍可能停在 1..3，上限调到 4 时写不进。未改已有 migration 文件。
  - 修复：运行时改为 `readVipStrategy().limits`。展示文案使用接口返回的上限，缺失时不补“3次”。新增 forward-fix `packages/shared/migrations/20260923_vip_strategy_media_limit_alignment.sql`，checksum `e309b460ed19efb3cd072d2775ca80aea148c97c8bdedd95f10013aba01e51cc`。它恢复按功能预留、把 `feature_free_trials` 与已有体验列序号收成 1..20，并让 admin 校验同时保住 VIP 策略键和高级图片键。旧键 `media_feature_free_trial_limit` 仍可被校验，但运营入口不再展示，运行时不读。
  - 已有 migration checksum：`20260922_media_feature_free_trials.sql` `aa2fdca6d8402fc14e48f80eccfe64c9b58ba417b38b3a794a96fd4167f509f4`；`20260923_admin_vip_media_config.sql` `83d758e51c916d66422044e82164bc26759aa7eb701f5aea789333eba6339169`；`20260923_vip_strategy_config.sql` `7fe41b2b435c4cb33305c77acab720aee593105e167db46b23d99ef32ced5f3d`。
  - 实际修改：`feature-free-trials.ts`、`feature-free-trial-limit.ts`、`FeatureFreeTrialRepository.ts`、`routes/voice.ts`、`routes/images.ts`、`features/image/config.ts`、前端 `media-billing-label.ts` 与聊天页/图片标签、Admin 媒体配置入口、`vip-billing-contracts.test.ts`、`scripts/test-vip-billing-migrations.sh`、本 `task.md`，以及新 SQL `20260923_vip_strategy_media_limit_alignment.sql`、`tests/vip_media_t5_scenarios.sql` 和对应单测。语音/图片结算状态机、钱包扣退原语、VIP 快照没有重写。
  - 本地联合矩阵（throwaway 库 `st_vip_t2_billing_test`，脚本结束即删除）：voice 用 1 次后 basic_image 仍独立；两者上限不同；voice=0 且 basic_image>0；voice>0 且 basic_image=0；上限 3→4 后下一序号为 4；上限 3→1 保留 3 条 consumed 且不再新增；上限 20 拒绝第 21 次；损坏配置回退 3；相同 reference 重放不占第二个序号；过期 reservation 可被回收；并发争抢最后一个 voice 序号只成功一个，且不写入 basic_image。体验列序号 4 可写、21 被拒绝。
  - 命令与结果：`bash scripts/test-vip-billing-migrations.sh` 通过（输出里并发签到仍有既有的 `daily check-in is not ready` 错误行，脚本断言仍通过）。`pnpm --filter @miniapp/shared test` 12 files / 108 tests 通过。`pnpm --filter @miniapp/backend test` 70 files / 624 tests 通过。`pnpm --filter @miniapp/backend typecheck` 在 `prisma generate` 后通过。`pnpm --filter @miniapp/frontend test` 28 files / 160 tests 通过；frontend typecheck 与 build 通过。`pnpm --filter @miniapp/admin` 的 navigation/config schema 测试通过。`pnpm -r typecheck` 通过。`pnpm lint:imports`、`pnpm lint:legacy`、`pnpm lint:migrations`、`pnpm test:migration-ledger` 通过。
  - 与 T6 的潜在冲突：`scripts/test-vip-billing-migrations.sh`、`packages/shared/src/__tests__/vip-billing-contracts.test.ts`、本 `task.md`。未改 reminder 脚本、notification route/contract、Railway Cron、`runtime-config.ts`、`docs/ARCHITECTURE.md`、T6 migration。
  - 未做：正式 test apply 与 apply 后只读 postflight；`20260922_media_feature_free_trials.sql` 与 `20260923_admin_vip_media_config.sql` 没有在带真实体验表的库上重放；媒体 settle/退款/failed_unknown/advanced VIP 快照没有在本轮新建端到端库，沿用子任务已有状态机。Production 未写。
  - 停止点：T5 不能标 Done。test 上若先单独 apply `20260923_admin_vip_media_config.sql`，会暂时盖掉 T3A 的 reserve；必须接着 apply alignment，且 alignment 之前不能有 ordinal > 20 的行。本轮没有执行这次 apply。
- 2026-09-23 将 `task/vip-t5-integration`（`a29788f`）合入 `dev_vip_0920`。T6 保持 Done。T5 保持 Doing。未 apply test，未进 T7，未写 Production。
- 2026-09-23 T5 test inspect 通过，T5 → Done。目标仍是 test `zoqelpfhurwehlvypryl`。三份文件均为 `match / applied`，checksum 与本地一致：`20260922_media_feature_free_trials.sql` `aa2fdca6d8402fc14e48f80eccfe64c9b58ba417b38b3a794a96fd4167f509f4`，`20260923_admin_vip_media_config.sql` `83d758e51c916d66422044e82164bc26759aa7eb701f5aea789333eba6339169`，`20260923_vip_strategy_media_limit_alignment.sql` `e309b460ed19efb3cd072d2775ca80aea148c97c8bdedd95f10013aba01e51cc`。`20260923_vip_strategy_config.sql` 仍是 `7fe41b2b435c4cb33305c77acab720aee593105e167db46b23d99ef32ced5f3d` / applied。alignment 在事务末尾自检 reserve 读取 `feature_free_trial_limits`、序号 1..20、voice 21 被拒绝；失败会整段回滚，因此 applied 表示 apply 当时这些检查已通过。apply 顺序是媒体免费额度、Admin 媒体配置、最后 alignment。未读业务行，未写 Production，未打开媒体或 VIP 开关，未进 T7。batch-lab 等 `not_applied` 不属于 T5。本地联合矩阵仍以 throwaway Postgres 为准，没有在 test 上重放用户额度。
- 2026-09-23 T7 开始，状态 Doing。分支 `dev_vip_0920`，HEAD `6c20e4d`，`HEAD...origin/dev_vip_0920` 为 `0 0`。保留并延续既有 dirty：本文件里 T5 从 Doing 改为 Done 及 test inspect 证据。未 pull/merge/rebase/commit/push，未重复 `task.py start`，未进 T8/T9。未写 test/Production，未改 feature flag、migration、Backend、Admin、Railway。
- 2026-09-23 T7 前端实现完成，**保持 Doing**。原因：非 VIP 的模型目录把 `discount_rate` 置空，`GET /api/vip/status` 和 `GET /api/payment/plans` 也不返回已发布文本折扣。一次性角标和未开通详情页因此不能展示服务端当前折扣；没有写死 88/95。需要 Shared/Backend 把已发布折扣率暴露给未开通用户后，角标才能收口。其余 T7 页面已接现有 hooks 和支付打开流程。
  - 复用：`usePaymentPlansQuery`、`useCreatePaymentOrderMutation`、`useWalletBalanceQuery`、`useDailyCheckinMutation`、`useModelCatalogQuery`、`useSelectModelMutation`、`openCreatedPayment`（原充值页外链/停录/订单页跳转）、`PaymentVpnPromptDialog`、`ChatModelSwitcher`、`formatFreeTrialBillingLabel`、通知 list/unread hooks、`GET /api/vip/status`、`POST /api/vip/entry-viewed`、`GET /api/notifications/:id`。
  - Demo 冲突：不照搬 88 折、语音 5 次、周卡 ¥13.99/月卡 ¥28.88、固定余额和日期；折扣、价格、天数、免费上限和提醒正文都只展示接口字段。原型外框、编号和说明文字没有进产品 UI。
  - 人工验证：本环境没有已登录的 Telegram WebView，也没有可切换的非 VIP/VIP/过期账号，不能对 Demo 做真实页面并排截图。静态构建已包含 `/vip` 与 `/profile/messages/[id]`。
  - 命令：`pnpm --filter @miniapp/frontend test` 30 files / 176 tests 通过。`pnpm --filter @miniapp/frontend lint` 无 warning。`pnpm --filter @miniapp/frontend typecheck` 通过。`pnpm --filter @miniapp/frontend build` 通过，路由含 `/vip`、`/profile/messages/[id]`。`pnpm lint:imports`、`pnpm lint:legacy` 通过。未改 Shared，未跑 shared test / 全仓 typecheck。
  - 构建之后的展示收尾：签到按钮仍用接口给出的合计预览，成功提示拆成两行并停留 3.2 秒；图片未知失败继续显示接口 message，跳转仍只看稳定 code。收尾后重新执行 `pnpm --filter @miniapp/frontend build`，通过，路由仍包含 `/vip` 与 `/profile/messages/[id]`。
  - 未操作 test/Production，未打开 VIP 购买、提醒或高级图片开关，未写数据库，未 commit/push，未进 T8/T9。
- 2026-09-23 PR #345 冲突处理：将最新 `origin/dev`（`0a2f05b`）合入 `dev_vip_0920`。人工解决 8 个冲突文件：Backend 保留上游 Batch Lab 调用并补齐 VIP entitlement、动态折扣快照、VIP 门禁和钱包策略预检；规范/架构文档保留较新有效事实并清除上游残留冲突标记。验证：Shared 12 files / 109 tests、Backend 72 files / 640 tests、Frontend 30 files / 176 tests、`pnpm -r typecheck`、`pnpm lint:imports`、`pnpm lint:legacy`、Frontend build 均通过。未操作 test/Production 或功能开关。
- 2026-09-24：产品将 VIP 两档价格改为周卡 1.00 元、月卡 2.00 元。更新 `VIP_PLAN_COMMERCIAL_TERMS` 与损坏回退默认值；新增 forward-fix `20260924_vip_plans_price_1_and_2_yuan.sql` 覆盖已发布 `vip_plans_config` 及未发布草稿的 `price_cents`。不改历史 migration，不重写订单快照。需在确认环境单文件 apply 后，页面和下单才会从 13.99/28.88 变成 1.00/2.00。
- 2026-09-24 T7 真机验收修正：Profile 星尘余额卡改为余额在左、VIP/星尘充值入口在右侧纵向排列；VIP 到期消息详情按 Demo 重组标题、时间、会员状态卡和到期影响说明，保留续费入口。到期说明的签到基础值、VIP 加成与文本折扣仍只读取 `GET /api/vip/status` 的已发布 `benefits`，当前 0.95 展示为 95 折；字段缺失时不猜测数值。今日/提前提醒首句由通知 metadata 格式化，历史通知正文未改写。验证：Frontend 31 files / 191 tests、typecheck、lint、build 通过，`pnpm lint:imports`、`pnpm lint:legacy` 通过。未改 Backend/Shared 契约/数据库/功能开关，未写 test 或 Production；真实 Telegram WebView 的窄屏视觉仍需部署后复验，T7 保持 Doing。
- 后续执行时每完成一个 Task，补充实际文件、命令、结果、失败路径、环境和剩余风险；不得只改 Status。

## T1 冻结给 T2 的公共契约

> 2026-09-22 需求补丁：本节记录 T1/T2 当时已冻结并落库的兼容契约。T3A 将通过 additive Shared 变更与 forward-fix migration 把商品条款、折扣、签到加成和媒体免费上限演进为受校验的运行时配置；下列 13.99/7、28.88/31/3000、0.95、3 是 20260923 首次 seed。2026-09-24 将损坏降级默认值改为 1.00/7、2.00/31/3000；已创建订单仍以快照为准。状态枚举、钱包策略、VIP 判定、幂等与退款语义仍保持冻结。

T2 只做 migration/RPC，必须使用这些名字，不得改语义。Producer（T3/T4）再写入 DTO；T1 为兼容把现有响应上的新字段做成可选。

### 枚举与常量

- `VipPlanId`: `'week' | 'month'`
- 周卡：`price_cents=100`，`duration_days=7`，`bonus_credits=0`
- 月卡：`price_cents=200`，`duration_days=31`，`bonus_credits=3000`
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

- `VipStatus`: `active`、`valid_from`、`valid_until`、`remaining_days`、`last_plan_id`、`entry_badge_visible`，以及可选的已发布权益预览 `benefits`
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

## 2026-09-23 T7 真机修复（已审核，执行中）

用户确认折扣为 95%，胶囊名称为轻量引擎/标准引擎/旗舰引擎，其余五项修复方案通过；先同步规划再实施。T7 保持 Doing，T8/T9 不自动推进。范围：VIP 展示契约、权益页及入口、顶部档位面板、媒体额度缓存。无环境配置或数据库写入。

- [x] 非 VIP 可取得权益与首次角标（Shared/Backend route 回归通过）
- [x] 三档引擎胶囊展开/收起（实现、typecheck、lint、build 通过）
- [x] 语音/初级图片额度终态刷新与失败处理（缓存失效回归通过）
- [x] Demo 布局与所有会员状态可见权益（组件实现与 build 通过）
- [x] 既有验证与补充回归完成
- [ ] PR 环境真机复验：角标跨刷新、胶囊手感/软键盘、媒体第 1 至 4 次与失败、VIP 页视觉

执行结果：Shared 12 files / 110 tests、Backend 72 files / 644 tests、Frontend 31 files / 187 tests 通过；`pnpm -r typecheck`、Frontend lint/build、`pnpm lint:imports`、`pnpm lint:legacy`、Prettier 与 `git diff --check` 通过。未操作数据库、运行配置、test/Production 开关、提交或推送。浏览器安全策略阻止本地 `file://` 视觉预览，因此未把本地静态渲染当成真机证据；T7 继续保持 Doing，等待 PR 真机复验。

### 2026-09-24 第二轮真机修正

- [x] 媒体终态使用 attempt 快照，失败不提前显示下一序号
- [x] VIP 详情权益文案按 Demo 结构对齐并保留动态 95%
- [x] 当前引擎胶囊增加绿色圆点
- [x] 非 VIP VIP 专属弹窗按 Demo 结构对齐，价格和签到权益动态读取
- [x] Frontend 验证与 diff 复核
- [x] TEST `vip_purchase_enabled` 开启并回读，Production 不变

执行结果：新增 attempt 快照格式化并用于图片/语音成功与失败展示；下一次按钮仍读取 `next_billing`。VIP 详情和锁定弹窗改为动态权益/套餐数据，顶部胶囊增加绿色状态点。Frontend 31 files / 189 tests、typecheck、lint、build、`pnpm lint:imports`、`pnpm lint:legacy` 与 `git diff --check` 通过。TEST `zoqelpfhurwehlvypryl` 回读 `environment=test`，将 `vip_purchase_enabled` 从 `false/version 1` 条件更新为 `true/version 2`，再次回读为 true；周/月价格仍为 1399/2888 分。Production 未操作。T7 保持 Doing，等待本轮 PR 真机复验。

### 2026-09-24 第三轮真机修正

- [x] 图片成功态移除重复的“重新生成 · 免费体验”按钮，只保留本次 attempt 的免费说明和原“看看TA”入口
- [x] VIP 详情权益卡边框与“VIP 会员”标题增加暗金流光，并支持 reduced motion 静态降级
- [x] 充值页 VIP 区按 Demo 重排标题、套餐摘要、赠送标签和选中态；价格与权益继续读取接口
- [x] 模型面板统一使用已发布 95 折：顶部改为“全部模型档位 95折已生效”，当前引擎显示折扣标识，每档保留原说明并追加服务端报价
- [x] Frontend 测试、typecheck、lint、build、import/legacy guards 与 diff 检查通过

执行结果：本轮仅修改 Frontend 展示与交互，没有改 Shared/Backend 契约、计费、支付、免费额度、数据库或环境开关。模型折扣率、计算值与最终实扣继续读取模型目录的服务端报价，未写死 88 折或示例金额。Frontend 31 files / 190 tests、typecheck、lint、build、`pnpm lint:imports`、`pnpm lint:legacy` 与 `git diff --check` 通过。T7 保持 Doing，等待 PR 环境真机复验流光观感、窄屏换行、图片入口和支付金额联动；Production 未操作。

### 2026-09-24 到期提醒 TEST 调度修复

- [x] VIP 详情周卡/月卡文案由“有效期内文本 95 折”改为“有效期内全部模型 95 折”
- [x] Railway Development 新建单实例 `stminiapp-vip-reminder-cron`，`20 * * * *` 以 `--write` 运行
- [x] PR 临时环境复制 Development 后删除 Reminder Cron，避免多个调度器扫描同一 TEST 库
- [x] TEST 开关条件更新并执行 dry-run、受控写入和幂等复跑
- [x] Production 不声明 Reminder Cron，未改 Production 开关或数据

根因：Railway Development 未创建 Reminder Cron；仓库期望态仍是 `--dry-run`；TEST `vip_reminders_enabled=false`。修复前 TEST dry-run 为 `scanned=2 / eligible=2 / failed=0`。Railway plan 先发现 16 个未纳入 IaC 的现有变量会被删除，因此补入 `preserve()` 清单后重新 plan，结果收敛为 `1 add / 0 change / 0 destroy`，再执行 apply。TEST `zoqelpfhurwehlvypryl` 回读 `environment=test`，将 `vip_reminders_enabled` 从 `false/version 1` 条件更新为 `true/version 2`。受控 `--write` 结果为 `scanned=2 / inserted=2 / failed=0`；立即复跑结果为 `scanned=0 / inserted=0 / failed=0`，未重复生成。Railway Reminder Cron 部署状态回读为 `SUCCESS`。未读取业务用户明细，账号 `7779109481` 的前端消息中心展示仍由真机验收确认。

### 2026-09-24 第四轮真机修正

- [x] VIP 到期提醒详情按 `expiring_soon` / `expires_today` 分为“VIP 即将到期”和“VIP 今日到期”两套 Demo 文案结构
- [x] 会员状态卡放大并增强外边框、内部分割线和右侧重点值，展示“3 天（至 MM-DD 到期）”或“今日到期（MM-DD HH:mm）”
- [x] 到期权益说明继续读取 `GET /api/vip/status` 的动态签到加成与模型折扣，保持当前 95 折口径，不照搬 Demo 的 88 折
- [x] 若用户已续费导致当前 `valid_until` 与通知 `observed_valid_until` 不一致，详情卡回退为实时会员剩余天数，避免旧通知覆盖新周期
- [x] Frontend 测试、typecheck、lint、build、import/legacy guards 与 diff 检查通过

执行结果：本轮仅修改 Frontend 的 VIP 到期消息详情展示和展示纯函数测试，没有改 Shared/Backend 契约、数据库、环境开关、调度器或支付逻辑。验证通过：`pnpm --filter @miniapp/frontend test`（31 files / 192 tests）、`pnpm --filter @miniapp/frontend build`、`pnpm lint:imports`、`pnpm lint:legacy`、`pnpm --filter @miniapp/frontend test -- src/lib/vip/presentation.test.ts`（1 file / 16 tests）、`pnpm --filter @miniapp/frontend typecheck`、`pnpm --filter @miniapp/frontend lint` 与 `git diff --check`。T7 保持 Doing，等待 PR 环境真机复验两类通知详情的窄屏布局、真实消息时间和续费入口；Production 未操作。

### 2026-09-24 第五轮真机修正

- [x] “我的”页 VIP 入口将次日 `00:00`（北京时间）按前一日 `24:00` 口径展示为“今日到期”
- [x] 到期提醒详情在当前会员周期已进入当天到期时，统一切换为“VIP 今日到期”标题和当天文案
- [x] `2026-09-25 00:00:00 Asia/Shanghai` 格式化为“今日到期（09-24 24:00）”，不再显示“剩余 1 天”
- [x] 签到加成和模型折扣继续读取服务端已发布权益，保持当前 95 折口径
- [x] Frontend 回归、typecheck、lint、build、import/legacy guards 与 diff 检查通过

执行结果：本轮仅修改 Frontend 展示 helper、到期消息详情页和既有 helper 测试；未改 Shared/Backend 契约、`remaining_days` 服务端语义、数据库、调度器、计费或环境开关。验证通过：`pnpm --filter @miniapp/frontend test -- src/lib/vip/presentation.test.ts`（1 file / 17 tests）、`pnpm --filter @miniapp/frontend test`（31 files / 193 tests）、`pnpm --filter @miniapp/frontend typecheck`、`pnpm --filter @miniapp/frontend lint`、`pnpm --filter @miniapp/frontend build`、`pnpm lint:imports`、`pnpm lint:legacy` 与 `git diff --check`。T7 保持 Doing，等待 PR 环境用账号 `7779109481` 复验两个页面；Production 未操作。

## 2026-09-24 T8

- 2026-09-24：产品确认 TEST 真机 VIP 验收全部通过。T7 → Done。T8 开始。未进 T9，未写 Production，未补执行 `20260924_vip_plans_price_1_and_2_yuan.sql`，未读取业务行。
- 2026-09-24 T8 → Done。跨包回归、文档和模块载荷校验完成。证据见 `research/t8-acceptance.md`。`module-updates.json` 已通过 `module_knowledge.py check`，尚未 apply，也未归档。Production 保持关闭。
