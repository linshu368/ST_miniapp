# T0 TEST-DB 只读采集

采集时间：2026-09-21 11:26 UTC（Asia/Shanghai 19:26）。工具：Cursor MCP `project-0-ST_miniAPP-supabase`（`get_project_url`、`list_tables`、`list_extensions`、`list_migrations`、`execute_sql` catalog、`get_advisors` security）。

**目标确认**：`get_project_url` → `https://zoqelpfhurwehlvypryl.supabase.co`。与仓库正式 test ref 一致。本文件全部为 `TEST-DB`，**不代表 production** `wbtsfzozlmurljvglhpn`。

范围：information_schema / pg_catalog、migration 账本文件名、指定 runtime_config 的非 secret shape、钱包 **聚合**守恒。未 `SELECT` 用户/订单/流水业务行，未导出 `api_key` / JWT / 连接串。未执行 DDL/DML，未跑 GitHub Actions `apply`。

## 1. Schema

存在：`admin`、`app_core`、`billing`、`cs_platform`、`experience`、`miniapp`、`miniapp_analytics`、`miniapp_features`、`miniapp_traffic`、`public`、`supabase_migrations`，以及 `aiero`、`batch_lab`、`miniapp_fdw`、系统 schema。

无 `cron` schema；`pg_cron` **未安装**。VIP reminder 不得依赖 test 上的 pg_cron，继续用 Railway Cron。

`postgres_fdw` 安装在 `public`（既有 advisor 项，本任务不修）。

## 2. 八域业务表（计数仅作结构辅助）

VIP 相关表均存在且 RLS **已启用**（无 policy，见 §5）：

| 表                                    | RLS | 行数（计数） |
| ------------------------------------- | --- | -----------: |
| `billing.user_wallets`                | on  |           31 |
| `billing.wallet_ledger`               | on  |          916 |
| `billing.payment_orders`              | on  |          215 |
| `billing.llm_usage_charges`           | on  |          814 |
| `miniapp_features.daily_checkins`     | on  |           94 |
| `miniapp_features.notifications`      | on  |           62 |
| `miniapp_features.notification_reads` | on  |           88 |
| `app_core.miniapp_user_settings`      | on  |           26 |
| `app_core.runtime_config`             | on  |           54 |
| `experience.chat_message_audio`       | on  |          127 |
| `experience.chat_message_images`      | on  |           77 |

MCP 另报 RLS **关闭**（既有，非本任务写入目标）：`experience.chat_history`、`miniapp_traffic.botlinks`、`miniapp_traffic.traffic_clicks`、`miniapp_features.character_ranking_scores`。T0 不自动 ENABLE。

## 3. 规划对象：均不存在（可 additive）

`billing.vip_memberships`、`vip_purchase_grants`、`feature_free_trials`、`wallet_refunds` 均为 `to_regclass = null`。`apply_wallet_debit` / `refund_wallet_debit` / `reserve_feature_free_trial` 均为 `to_regprocedure = null`。无 `vip_*` 函数。

列缺口（相对 design，待 T2 扩展，不改历史 migration）：

- `billing.payment_orders`：**已有** `settled_by` + check `webhook|return|query|cron`；**没有** `product_type` / `product_id` / `vip_duration_days` / `vip_bonus_credits` / `fulfillment_applied` / `vip_valid_until`。
- `app_core.miniapp_user_settings`（设计文里的 `user_settings` 实际表名）：**没有** `vip_entry_seen_at`。
- `miniapp_features.notifications`：有 `scope`/`user_id`/`category`；**没有** `kind` / `business_key` / `action_path` / metadata。
- `experience.chat_message_images`：**没有** `image_tier`（子任务列）。
- `experience.chat_message_audio`：**没有** 免费预留关联列（子任务列）。
- `wallet_ledger.entry_type` check 现含 `recharge|chat_debit|refund|adjustment|checkin_bonus|wish_reward|invite_reward|community_reward|image_generation`。T2 若新增 VIP 赠送/退款类型必须 **扩展 check**，不能静默插入未知 type。

## 4. 函数

| 函数                                                                        | 安全    | search_path  | 备注                          |
| --------------------------------------------------------------------------- | ------- | ------------ | ----------------------------- |
| `billing.complete_payment_order(text,text,text)` → `billing.payment_orders` | DEFINER | **未固定**   | 四路结算 DB 出口              |
| `billing.grant_bonus_credits(...)`                                          | DEFINER | `pg_catalog` | 签到/月卡赠送应复用           |
| `billing.charge_llm_usage(...)`                                             | DEFINER | `pg_catalog` | 仍允许 partial 语义（代码侧） |
| `billing.charge_voice_usage(...)`                                           | DEFINER | `pg_catalog` | 媒体子任务扩展点              |
| `billing.settle_image_generation(...)`                                      | DEFINER | `pg_catalog` | 媒体子任务扩展点              |
| `miniapp_features.claim_daily_checkin(uuid)`                                | DEFINER | **未固定**   | 读 runtime_config 发 bonus    |
| `miniapp_traffic.check_invite_first_paid_reward(...)`                       | DEFINER | `pg_catalog` | 邀请首次付费，T3 保持口径     |

EXECUTE（`has_function_privilege`）：

- `grant_bonus_credits` / `charge_llm_usage` / `charge_voice_usage` / `settle_image_generation`：anon/authenticated = **false**；service_role/postgres = true。
- `complete_payment_order` 与 `claim_daily_checkin`：anon/authenticated = **true**（SECURITY DEFINER 会绕过 RLS）。**GAP**：新 VIP RPC 不得复制该授权；应 `REVOKE ALL FROM PUBLIC` 后只 grant service_role/postgres。本任务不趁机改旧函数授权，除非 T2 同文件必须触碰签名。

## 5. RLS / grants / 索引

- 上表 RLS on、**零 policy**。advisor `rls_enabled_no_policy` 计数 47（含大量既有表）。对 PostgREST 角色，无 policy ≈ 默认拒绝；`has_table_privilege` 仍显示 anon/authenticated 对 wallets/orders/checkins/settings/runtime_config 有 SELECT/INSERT/UPDATE/DELETE。
- `miniapp_features.notifications`：anon/authenticated 表权限为 **false**。**T2 新 billing 表应学 notifications：RLS on + 不 grant anon/authenticated**，不要只靠“无 policy”。
- 支付对账索引已在：`idx_payment_orders_due_reconcile`。
- `wallet_ledger` 无 payment_order 专用 unique；履约幂等靠订单 `credits_added`。T2 VIP grant 需 `vip_purchase_grants.order_id` PK。
- `notifications` 无 `business_key` unique，T2 必须加。

## 6. Migration 账本

`supabase_migrations.repo_migrations` 10 行（日期账本，2026-09-10 之后）：

1. `20260910_schema_migrations_ledger.sql`
2. `110_characters_add_persona_and_style.sql`
3. `20260911_billing_grant_bonus_credits.sql`
4. `20260914_repo_migration_ledger_events.sql`
5. `20260911_chat_history_billing_settlement.sql`
6. `20260916_chat_image_description_drafts.sql`
7. `20260916_reconcile_chat_image_managed_config_keys.sql`
8. `20260918_expand_chat_image_prompt_limit.sql`
9. `20260920_image_description_system_prompt_config.sql`
10. `20260917_llm_provider_routing_config.sql`

CLI `schema_migrations` 另有 24 行（旧 bot/analytics 链），**不要**与 repo 账本混用。

**GAP**：`20260914_chat_message_images.sql` 等更早编号文件不在 repo 账本，但图片/语音/settled_by 对象已存在。T2 新文件必须走 GitHub Actions `apply` 写入 `repo_migrations`。最新已记账日期文件为 `20260920_image_description_system_prompt_config.sql` 与 `20260917_llm_provider_routing_config.sql`。

## 7. Runtime config（test 实值）

| key                                                                    | version | 安全可读值                                                  |
| ---------------------------------------------------------------------- | ------: | ----------------------------------------------------------- |
| `miniapp_daily_checkin_bonus_credits`                                  |       5 | **40**                                                      |
| `llm_pricing_config.fixedDeduction`                                    |      10 | light 15 / standard 30 / premium 50 / freeQuotaExhausted 16 |
| `llm_model_catalog`                                                    |      60 | 存在（object）；未导出目录正文                              |
| `miniapp_payment_plans`                                                |      10 | 存在（array）；未导出套餐明细                               |
| `image_generation_enabled`                                             |       1 | **true**（初级图片总开关，不是高级档）                      |
| `image_generation_credits`                                             |       2 | 60                                                          |
| `image_price_label`                                                    |       1 | `60 星尘`                                                   |
| `image_text_model_config`                                              |       7 | url/model/api_key **均有**；未导出 secret                   |
| `vip_purchase_enabled` / `vip_reminders_enabled` / advanced image keys |       — | **不存在**                                                  |

结论：

- test 基础签到当前是 **40**，不是 60。T3 把 test 收敛为 60 前须单独记录；**不得**把 40 当 production 事实。
- 95 折必须用上述 test 原价快照计算，禁止写死原型数字。
- 初级图片在 test 已开；**高级图片配置键不存在，保持关闭**。

## 8. 钱包守恒聚合

`count=31`；`sum(main)+sum(bonus)=sum(total)` 为 **true**。T2 前后应用同一聚合 SQL 对照。数字会变，本行只证明 generated `total_credits` 口径当前成立。

## 9. 对 T1/T2 的含义

- T1 可以开始：test 前置 shape 已知，公共契约不依赖再连库。
- T2 可以按 additive 设计写 SQL，但 **执行** 仍须 GitHub Actions `apply` + `environment=test`，一次一个文件。
- T2 新对象归属无需改八域结论。
- 新 RPC 必须固定 `search_path`，REVOKE PUBLIC，只 grant service_role/postgres。
- Production 结构/签到/价格仍 `PROD-UNVERIFIED`。
