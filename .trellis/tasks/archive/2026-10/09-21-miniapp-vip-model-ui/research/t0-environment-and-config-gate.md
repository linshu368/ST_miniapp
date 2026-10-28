# T0 环境、配置与停止条件核验

采集时间：2026-09-21（Asia/Shanghai）。操作者：父任务实施会话。当前分支：`dev_vip_0920`。

本文件记录门禁、用户确认与停止条件。test 活库结构见 `t0-test-db-collection.md`（`TEST-DB`，2026-09-21 19:26 CST）。未读取业务行，未执行 migration，未启动语音/图片子任务，未修改产品代码。

## 证据标签

| 标签              | 含义                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `REPO`            | 当前工作树源码、migration、IaC、workflow 或已审核规划中可核对的事实 |
| `TEST-DB`         | 已确认指向正式 test 项目 `zoqelpfhurwehlvypryl` 的只读结构/配置实况 |
| `PROD-UNVERIFIED` | Production 需要独立核验；不得用 test 或仓库默认值代替               |
| `INFER`           | 推断，不是当前事实                                                  |
| `BLOCKED`         | 本轮因缺少确认/工具而未采集                                         |

本轮此前 **没有** `TEST-DB` 证据。`.trellis/spec/database/supabase/test-database-reference.md` 记录的 2026-09-07 MCP 采集指向 `lhcyrmigpqeloxjrfwmn`，规范已标明它不是正式 test，不能作为本任务前置。**2026-09-21 19:26 已用只读 MCP 采集正式 test `zoqelpfhurwehlvypryl`，见 `t0-test-db-collection.md`。**

## 0. 2026-09-21 用户确认（写入后仍未连库）

| 项                         | 用户决定                                                                                            | 标签                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| 开发/测试阶段数据库        | 正式 test `zoqelpfhurwehlvypryl`                                                                    | 用户确认；**已** `TEST-DB` 采集  |
| 上生产后数据库             | `wbtsfzozlmurljvglhpn`；本阶段不写入、不把 test 当 production                                       | 用户确认；`PROD-UNVERIFIED`      |
| 只读 MCP vs GitHub Actions | MCP **只做结构采集**；真正执行 migration 仍必须走 `.github/workflows/db-migrate.yml` 单文件 `apply` | `REPO` + 用户确认可接入只读 MCP  |
| 高级图片                   | 本迭代保持关闭                                                                                      | 用户确认，与仓库无高级档配置一致 |
| T1 时机                    | **等 T0 采集完成后再进 T1**                                                                         | 用户确认                         |
| `dev_vip_0920` Railway     | 跟随 GitHub 更新自动部署 **PR 环境**（`railway-pr-env.yml` 复制 development，永不复制 production）  | 用户确认 + `REPO`                |

`.cursor/mcp.json` 已被 gitignore：`project-ref=zoqelpfhurwehlvypryl` 且含 `--read-only`。2026-09-21 会话已加载 namespace `project-0-ST_miniAPP-supabase`；`get_project_url` 返回 `https://zoqelpfhurwehlvypryl.supabase.co`。采集结果见 `t0-test-db-collection.md`。access token 不得写入 research/spec/Git。

### MCP 与 GitHub Actions 分工（T0 裁定）

| 工具                       | 能做什么                                                                                                                                                                            | 不能做什么                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 只读 Supabase MCP          | T0 catalog：schema/table/function/index/RLS/grant；可读 `supabase_migrations.repo_migrations` 文件名/checksum；只读指定 runtime_config **key 的存在性/类型/version/非 secret 数值** | **不能** 执行或替代 migration；不能当生产入口 |
| `db-migrate.yml` `inspect` | 仓库文件 ↔ 账本 ↔ 少量对象探针的只读互证                                                                                                                                            | 不改库；不是 T2 执行通道                      |
| `db-migrate.yml` `apply`   | **唯一正式改库入口**：一次一个 `packages/shared/migrations/*.sql`，校验 project ref，成功记账                                                                                       | 不得用 MCP、Studio、本地 `psql` 绕过          |

因此：接入只读 MCP **不会**免除你在 T2/T8/T9 时到 GitHub Actions 手动 `apply`。T0 采集本身也不需要现在去 Actions 跑 migration。

## 1. 任务与环境身份

| 项                               | 结论                                                                                                        | 标签                     | 证据                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git 分支                         | `dev_vip_0920`                                                                                              | `REPO`                   | `git branch --show-current`                                                                                                                             |
| 父任务                           | `09-21-miniapp-vip-model-ui`，`task.py start` 后 `status=in_progress`                                       | `REPO`                   | `task.json`；`task.py current --source` → session `cursor_911cf8ee-54f8-4f61-87b4-ac6e0d058371`                                                         |
| 语音子任务                       | `09-21-vip-voice-free-trials`，`parent` 已指向父任务，`status=planning`，未 start                           | `REPO`                   | 父 `children`；子 `task.json.parent`；`task.py list`                                                                                                    |
| 图片子任务                       | `09-21-vip-image-free-trials`，同上                                                                         | `REPO`                   | 同上                                                                                                                                                    |
| 正式 test ref                    | `zoqelpfhurwehlvypryl`                                                                                      | `REPO`                   | `.github/workflows/db-migrate.yml`、`packages/shared/src/config/database.ts`、`packages/shared/migrations/README.md`、`package.json supabase:link:test` |
| 正式 production ref              | `wbtsfzozlmurljvglhpn`                                                                                      | `REPO`                   | 同上 workflow / database.ts                                                                                                                             |
| 本会话数据库目标                 | 开发/测试 = 正式 test `zoqelpfhurwehlvypryl`（已 MCP 核验 URL）；生产 = `wbtsfzozlmurljvglhpn` 本阶段不写入 | 用户确认 + `TEST-DB` URL | `get_project_url`                                                                                                                                       |
| 本机/Railway 当前 `DATABASE_ENV` | 未读取任何 `.env` 或控制台 secret                                                                           | `BLOCKED`                | 避免索取或输出凭据                                                                                                                                      |

`createDatabaseConfig` 把 `DATABASE_ENV=development|test` 都映射为 **target=test**，只有 `production` 映射为 production。Railway `development` 与 PR 环境按仓库设计应使用 `TEST_*` 指向 test 库；**live 绑定本轮未验证**。

## 2. 预期只读采集清单（确认正式 test 后执行）

允许工具：GitHub Actions `db-migrate.yml` 的 `mode=inspect` + `environment=test`，或已确认指向 `zoqelpfhurwehlvypryl` 的 Supabase MCP catalog 查询。禁止 DDL/DML，禁止 `SELECT` 业务行。`app_core.runtime_config` 只读指定 key 的 **存在性、类型、version**；签到/价格类数值属于配置核验范围，仍不得导出其他 key 的 secret 文本。

### 2.1 Schema 存在性

`app_core`、`billing`、`experience`、`miniapp_features`、`admin`、`miniapp_traffic`、`supabase_migrations`。`public` / 旧 `analytics` 只计数，不作为本任务写入目标。

### 2.2 表 / 列 / 约束（不读行内容）

| 对象                                                    | 采集重点                                                               | 规划用途                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| `billing.user_wallets`                                  | `main_credits`、`bonus_credits`、generated `total_credits`、PK/FK、RLS | 守恒口径；不搬余额         |
| `billing.wallet_ledger`                                 | `main_delta`/`bonus_delta`、unique 业务键、索引                        | 原路退款真相               |
| `billing.payment_orders`                                | 现有 credits 字段、`credits_added`、`settled_by` check、对账列、索引   | VIP 商品快照扩展前置       |
| `billing.llm_usage_charges` / `llm_usage_charge_dedup`  | 扣费幂等键与 status 集合                                               | 取消新 partial 的兼容      |
| `miniapp_features.daily_checkins`                       | `user_id+claimed_at` 索引、奖励列                                      | 签到 60/120                |
| `miniapp_features.notifications` / `notification_reads` | 现有 scope/user_id、已读表                                             | 提醒 business_key          |
| `app_core.users` / `app_core.user_settings`             | PK 类型；settings 无 `vip_entry_seen_at`                               | 角标持久化                 |
| `app_core.runtime_config`                               | 见 §4–§5 key 清单                                                      | 签到、模型价、图片开关     |
| `experience` 语音/图片 attempt 表                       | 列集合即可；attempt 快照列归子任务                                     | 确认父 T2 不改领域状态机   |
| `supabase_migrations.repo_migrations`                   | **已执行 filename 列表与 checksum**                                    | T2 前置；仓库文件 ≠ 已执行 |

Prisma `schema.prisma` 映射了 wallets/orders/settings，但 **未映射** SQL `103` 的 `payment_orders.settled_by`。`REPO`：应用 repository 已读该列。`TEST-DB`：列是否存在待采集。

### 2.3 函数签名 / 安全属性

必须采集 `to_regprocedure`、`prosecdef`、`proconfig`（search_path）、参数与返回类型、EXECUTE grants：

- `billing.complete_payment_order`
- `billing.grant_bonus_credits`
- `billing.charge_llm_usage`
- `billing.charge_voice_usage`
- `billing.settle_image_generation`
- `miniapp_features.claim_daily_checkin`
- 邀请首次付费相关 RPC（回归锁定用，不改口径）

确认这些对象 **尚不存在**：`billing.vip_memberships`、`vip_purchase_grants`、`feature_free_trials`、`wallet_refunds`、`apply_wallet_debit`、`refund_wallet_debit`、`reserve_feature_free_trial`。

### 2.4 索引、RLS、grants

对上表：RLS 开/关、policy 名、`anon`/`authenticated`/`service_role`/`postgres` 的 table/function grant。规划要求新 billing 表 RLS on、anon/authenticated 无直接权限。

### 2.5 跨 schema 依赖

`claim_daily_checkin`（miniapp_features）→ `grant_bonus_credits` + `user_wallets`（billing）+ `runtime_config`（app_core）。Reminder RPC 将再读 billing 会员、写 miniapp_features 通知，T2 设计必须单列该依赖。

### 2.6 仓库声明的最近 migration（≠ 已执行）

日期命名链最新文件包括 `20260920_image_description_system_prompt_config.sql`。是否已在 test/production 记账 **本轮未知**。T2 前必须用账本而不是目录列表。

## 3. 基础签到 60

| 来源                                                              | 值                                              | 标签                 |
| ----------------------------------------------------------------- | ----------------------------------------------- | -------------------- |
| `031_signup_and_checkin_rewards.sql`                              | 写入 `miniapp_daily_checkin_bonus_credits = 60` | `REPO` / `MIGRATION` |
| `032_daily_checkin_reward_40.sql`                                 | **覆盖为 40**                                   | `REPO` / `MIGRATION` |
| 032 之后无 migration 再改为 60                                    | 迁移链最后声明是 40                             | `REPO`               |
| Admin `configMetadata.defaultValue`                               | 40                                              | `REPO`               |
| `MiniappWalletRepository.getDailyCheckinStatus` 解析失败 fallback | 40                                              | `REPO`               |
| `claim_daily_checkin` SQL `COALESCE(..., 10)`                     | 配置缺失时发 10                                 | `REPO`               |
| test 当前 `runtime_config` 值                                     | **40**                                          | `TEST-DB`            |
| production 当前值                                                 | 未采集                                          | `PROD-UNVERIFIED`    |

**结论**：test 基础签到当前是 40，不是 60。把 test 收敛为 60 是 T3 行为变更，须单独记录。production 仍未核，不得套用 test。

展示路径 fallback=40 与发放 RPC fallback=10 不一致。`INFER`：若配置行缺失，UI 可能显示 40 而实际发放 10。T3 收敛时应一并消除，不在 T0 改代码。

## 4. 高级图片：保持关闭

仓库 **没有** 独立的高级图片 provider / model / price / enabled 配置键。

现有图片是单一产品，配置来源：

| 项             | 现有来源                                                                                                            | 标签                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 入口开关       | `app_core.runtime_config.image_generation_enabled`（migration 默认 `false`，Admin default 亦 false）                | `REPO`                  |
| 价格           | `image_generation_credits` + `image_price_label`；代码 fallback 50；migration 曾 seed 60                            | `REPO`；**live 值未核** |
| 文生图写稿模型 | `image_text_model_config`；不完整则回退 DeepSeek `voice.draft`                                                      | `REPO`                  |
| 出图 provider  | 环境变量：`LIAOBOTS_*` / `GROK_MODEL` 主路径，`REPLICATE_TOKEN` / `Z_MODEL`（默认 `prunaai/z-image-turbo`）失败回退 | `REPO`                  |
| 超时/worker    | `IMAGE_GENERATION_TIMEOUT_MS` 等，经 `platform/config.ts`                                                           | `REPO`                  |
| 请求档位       | shared/image API **无** `tier: basic\|advanced`                                                                     | `REPO`                  |

`image_generation_credits` 的 migration seed（60）与 Admin/代码 fallback（50）冲突，只能说明 **单一产品价格也必须以 runtime_config 实值为准**。这仍不是高级档配置。

**T0 裁定（非猜测，2026-09-21 用户同意）**：高级图片配置不完整、不可验证 → **高级图片保持关闭**。不阻塞其余 VIP 能力的契约与底座设计。开放条件：受控 runtime config 同时具备 enabled、provider/model、price、展示文案，且 test 只读核验通过。

## 5. 模型原价与功能开关入口

| 配置                                                                   | 读取入口                                                    | 本轮实值                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `llm_model_catalog` / `llm_pricing_config.fixedDeduction`              | `platform/runtime-config.ts` → `model-tiers.ts`             | `TEST-DB`：light 15 / standard 30 / premium 50 / freeQuotaExhausted 16；catalog version 60 |
| `miniapp_payment_plans`                                                | runtime_config + Admin                                      | `BLOCKED`                                                                                  |
| 规划中的 `vip_purchase_enabled`、`vip_reminders_enabled`、高级图片开关 | 仅存在于 design/implement，代码与 managed keys **尚未创建** | `REPO`                                                                                     |
| 现有图片总开关                                                         | `image_generation_enabled`                                  | 见 §4                                                                                      |

95 折必须基于同一 runtime 原价快照计算。T1 纯函数可先用契约测试；T3/T4 不得写死原型示例价。

## 6. Railway test 服务、支付四路、Reminder Cron

### 6.1 Railway 配置入口

`REPO`：

- IaC：`.railway/railway.ts`（需 `railway config plan/apply`，push 不会自动生效）
- 说明：`ops/railway/README.md`、`docs/ARCHITECTURE.md`
- 环境：`development` 跟分支 `dev`，变量用 `TEST_*`；`production` 跟 `main`，变量用 `PROD_*`
- 服务：`stminiapp`（API）、`stminiapp-payment-reconcile-cron`（常驻，`tsx src/scripts/reconcile-payment-orders.ts`）、`stminiapp-payment-cron`（`*/5`，`tsx src/scripts/expire-payment-orders.ts`）

`PROD-UNVERIFIED` / `BLOCKED`：控制台是否已 apply IaC、development 是否指向正式 test、三服务当前 commit，本轮均未登录 Railway。

`REPO`：IaC 的 `development` 跟踪分支 **`dev`**。用户确认 `dev_vip_0920` 的 Railway 部署方式是：**GitHub 更新后由 `railway-pr-env.yml` 自动创建/更新 `pr-{N}` 环境**（复制 `development`，域名 `https://stminiapp-pr-{N}.up.railway.app`，**永不复制 production**）。因此本分支联调入口是 PR 环境，不是把 `development` 改去跟踪 `dev_vip_0920`。PR 环境是否已存在、是否指向 test 库，本轮未 live 验证。

### 6.2 支付四路结算

`REPO`：`PaymentSettlementSource = webhook | return | query | cron`。应用层唯一出口 `settlePaidOrder` → DB `complete_payment_order`。

| 来源    | 入口                                                       |
| ------- | ---------------------------------------------------------- |
| webhook | `routes/payment.ts` `POST\|GET /api/payment/webhook/zqpay` |
| return  | `GET /api/payment/return`                                  |
| query   | `GET /api/payment/orders/:id`                              |
| cron    | 快速对账 worker + 过期脚本，settled_by 均为 `cron`         |

支付测试通路是否在 Railway development **真实可用**（`PAYMENT_ENABLED`、网关、回调 URL）本轮未验证。Stage 0 门禁把“支付测试通路不可验证”列为停止项：**T3 支付改造前必须有 test 支付 smoke 证据**；T1 契约定义不依赖真实下单。

### 6.3 Reminder Cron

仓库 **没有** VIP reminder 脚本或 Railway 服务。配置入口应复用支付 Cron 模式：

1. Backend 有界脚本（先 dry-run 指标，再写入）
2. 独立 Railway Cron 服务，**禁止**把 schedule 配到 `stminiapp` HTTP 服务
3. 环境变量 reference 指向 API 服务的 `DATABASE_ENV` / `TEST_*` 或 `PROD_*`
4. `vip_reminders_enabled` 默认 false；Production 保持关闭，直到产品确认

`PROD-UNVERIFIED`：Production 不得因 test Cron 存在而启用写入。

## 7. 停止条件、待用户确认、T1/T2 证据

### 7.1 已触发或仍然有效的停止条件

来自 design §12 / implement 阶段 0，本轮对照：

| 条件                                           | 本轮状态                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| 目标环境不明确                                 | **已解除**：MCP URL = 正式 test `zoqelpfhurwehlvypryl`               |
| 现有 schema 不满足 migration 前置              | **未命中**：八域业务 schema 存在；规划 VIP 对象均不存在，可 additive |
| 高级图片冒充可用                               | **未命中**：无高级档配置键；用户同意保持关闭                         |
| 支付测试通路不可验证                           | **未在本轮验证**；阻塞 T3 实支付，不自动阻塞 T1                      |
| 产品不同意“已售权益不可回滚”                   | 规划已写该原则；**需产品在发布前再次确认**，T0 不视为已签字          |
| 余额不守恒 / 重复履约 / 权限绕过 / 免费超领 等 | 实施期停止条件，T0 未执行业务                                        |

### 7.2 待用户确认（不索取凭据）

已确认：

1. 开发/测试目标 = 正式 test `zoqelpfhurwehlvypryl`；上生产后才用 `wbtsfzozlmurljvglhpn`。
2. 切勿把 `lhcyrmigpqeloxjrfwmn` 当作本任务 test。
3. 本阶段 Production 只记录、零写入。
4. 高级图片本迭代保持关闭。
5. `dev_vip_0920` 走 GitHub PR 自动 Railway `pr-{N}` 环境。
6. **等 T0 采集完成后再进 T1**；未授权提前做契约。
7. 可接入只读 Supabase MCP；**不改变** T2 起仍须 GitHub Actions 手动 `apply` 的规则。

仍待操作（非 T0 阻塞）：

- Production 签到/价格/schema 仍未采集（T9 前独立核验）。
- Railway `pr-{N}` 与支付 test smoke 仍未 live 验证（T3 前）。
- test 签到 40→60 的配置变更在 T3 执行并记录。

### 7.3 进入 T1 前

T0 采集已完成。T1 最低证据已具备：

- 正式 test 只读结构采集：`research/t0-test-db-collection.md`
- 高级图片关闭裁定已记录
- migration 账本文件名已记录

**本轮写完 T0 后停下，不自动开始 T1。** 下一轮可进入 T1。

### 7.4 进入 T2 前（硬门禁）

必须同时具备：

1. 正式 test 的 schema/table/function/index/RLS/grant 只读采集，标签 `TEST-DB`
2. `supabase_migrations.repo_migrations` 已执行文件列表
3. test 的 `miniapp_daily_checkin_bonus_credits` 与 `llm_pricing_config`/`image_generation_*` 配置 shape（无 secret）
4. 确认目标对象尚不存在，避免重名
5. Production 只列待核清单，不执行

缺任一项不得写/跑 migration。

### 7.5 父 T2 完成后才能向语音/图片工程师交付

当前 **不具备** 交付条件。子任务仍为 `planning` / `unassigned`。交付物（T2 完成后）至少包括：稳定 commit、`feature_free_trials` 与 reserve/release RPC、wallet allocator/refund 签名、Shared 免费状态类型、默认关闭开关、test 验证证据。语音/basic 不等待 T3/T4；advanced 额外等父 T3。

## 8. 本轮明确未做

- 未连接 test/production
- 未改 `AGENTS.md`、数据库 spec、产品代码
- 未 start/修改两个媒体子任务
- 未 commit / amend / push
