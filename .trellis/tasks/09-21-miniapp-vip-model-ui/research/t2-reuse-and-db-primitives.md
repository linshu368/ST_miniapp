# T2 现状复用核验与数据库原语设计证据

采集时间：2026-09-21 12:05 UTC（Asia/Shanghai 20:05）。工具：Cursor MCP `project-0-ST_miniAPP-supabase` 只读 catalog。

**目标确认**：`get_project_url` → `https://zoqelpfhurwehlvypryl.supabase.co`。全部为 `TEST-DB`，**不代表 Production** `wbtsfzozlmurljvglhpn`。未 `SELECT` 业务明细行。未 DDL/DML，未触发 GitHub Actions。

官方文档本轮相关结论（changelog + function/RLS 文档检索）：

- test 为 PostgreSQL **17.6**；`pg_cron` 仍未安装，不得为本任务引入。
- PostgreSQL 默认把新函数 `EXECUTE` 授给 `PUBLIC`；`SECURITY DEFINER` 必须固定 `search_path`、schema-qualify、`REVOKE ALL FROM PUBLIC`。
- 启用 RLS 不会自动建立 policy；新 billing 表学 `miniapp_features.notifications`：RLS on + **不 grant** `anon`/`authenticated`，不建宽泛用户 policy。
- changelog 近期条目不改变本任务的 RLS / function grant / 事务锁策略。

T1 TypeScript 与数据库命名：**无必须停止的字段改名冲突**。记录一项精度差异（不是命名冲突，不改 T1）：钱包列是 `NUMERIC(14,1)` 生成列 `total_credits`，T1 公共契约是整数。T2 RPC 使用 `NUMERIC(14,1)` 对齐现表，并拒绝非正金额。

## 1. 现有对象：真实定义与复用决定

| 对象                                                                          | TEST-DB 事实                                                                                                                                                                                                                                 | 调用关系                                               | 决定                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.user_wallets`                                                        | PK `user_id` → `app_core.users`；`main_credits`/`bonus_credits` `NUMERIC(14,1)` ≥ 0；`total_credits` **generated stored** = main+bonus；RLS on、0 policy；anon/authenticated **仍有表 ACL**（历史缺口）                                      | 充值、发奖、LLM/语音/图片扣费                          | **复用**现表现列。不搬余额、不改 generated 口径。新表不复制钱包。不顺带收回旧表 anon ACL。                                                                                                  |
| `billing.wallet_ledger`                                                       | `entry_type` check = `recharge\|chat_debit\|refund\|adjustment\|checkin_bonus\|wish_reward\|invite_reward\|community_reward\|image_generation`；非唯一 `(reference_type, reference_id)` 索引；部分唯一：`image_generation`、`outreach_grant` | 所有资金事实                                           | **扩展** check 增加 `vip_bonus`；**新增**可空 `debit_key` + 部分唯一索引。不改写历史流水。                                                                                                  |
| `billing.grant_bonus_credits`                                                 | DEFINER，`search_path=pg_catalog`；anon EXECUTE=false；**无引用幂等**                                                                                                                                                                        | 签到/许愿/注册/运营/邀请/社群                          | **复用**发月卡 3000。禁止手写 `bonus_credits = bonus_credits +`（legacy guard）。幂等靠 `vip_purchase_grants` + `uq_wallet_ledger_vip_bonus_order`。                                        |
| `billing.charge_llm_usage` / `charge_voice_usage` / `settle_image_generation` | 均 DEFINER + 固定 search_path；仍是 bonus-first，LLM 允许 partial                                                                                                                                                                            | T4 / 媒体子任务才改调用方                              | **不复用为 VIP 扣款实现**。T2 新增内部 `apply_wallet_debit`。本轮不改这三个函数。                                                                                                           |
| 旧 `refund_chat_message_charge`                                               | 已删除                                                                                                                                                                                                                                       | —                                                      | **不恢复**聊天专用退款表。新增 `billing.wallet_refunds` + `refund_wallet_debit`。                                                                                                           |
| `billing.payment_orders`                                                      | 215 行；已有 `settled_by` check；**无** VIP 快照列；`credits_amount >= 0`                                                                                                                                                                    | Backend `MiniappPaymentOrderRepository.complete` → RPC | **扩展列** + CHECK。历史回填 `product_type='credits'`（DEFAULT）、`fulfillment_applied=credits_added`。                                                                                     |
| `billing.complete_payment_order(text,text,text default null)`                 | DEFINER，**未固定 search_path**；ACL `{=X/postgres,...}` 即 **PUBLIC EXECUTE**；幂等靠 `completed AND credits_added`                                                                                                                         | 四路 `PaymentSettlement`，service_role                 | **兼容扩展同一签名**。credits 路径保持现行为并写 `fulfillment_applied`。VIP 路径加会员/grant/月卡 bonus。因新路径动会员与专项星尘，**必须 REVOKE PUBLIC**（阻止安全实现，不是顺带修历史）。 |
| `miniapp_features.claim_daily_checkin(uuid)`                                  | DEFINER，无 search_path；PUBLIC+anon+authenticated EXECUTE；奖励读 `miniapp_daily_checkin_bonus_credits`，fallback **10**；test 配置值 **40**                                                                                                | `MiniappWalletRepository.claimDailyCheckin`            | **扩展**：用户 advisory lock + 同事务读/锁 VIP 行；**不改奖励数值**。返回 additive `base_reward_credits`/`vip_reward_credits`（本轮 vip=0）。保留现有 EXECUTE 授权，避免改变旧调用面。      |
| `miniapp_features.notifications`                                              | RLS on、**零表 grant 给 anon**；`scope` 允许 official+user_id 定向；无 `kind`/`business_key`                                                                                                                                                 | 消息中心                                               | **扩展列** + 非空 `business_key` 唯一。学此表的 grant 模型给新 billing 表。                                                                                                                 |
| `app_core.miniapp_user_settings`                                              | 26 行；无 `vip_entry_seen_at`。设计旧称 `user_settings` **不存在**                                                                                                                                                                           | 设置仓库                                               | **只加列** `vip_entry_seen_at`。不建错表。                                                                                                                                                  |
| `miniapp_features.daily_checkins`                                             | 无用户级唯一；首次领取无行可锁                                                                                                                                                                                                               | 签到 RPC                                               | **不改表**。用 `pg_advisory_xact_lock` 补首次并发。                                                                                                                                         |
| migration lint / ledger                                                       | `pnpm lint:migrations`；`pnpm test:migration-ledger`；正式 apply = `.github/workflows/db-migrate.yml` 单文件                                                                                                                                 | T2 发布                                                | **复用**。本窗口禁止 apply。`force_rerun` 仅审核后的恢复。                                                                                                                                  |
| `pg_cron`                                                                     | 未安装                                                                                                                                                                                                                                       | —                                                      | **不引入**。提醒扫描仍留给 T6 Railway Cron。                                                                                                                                                |

### 聚合证据（无明细）

| 指标                                  | n                                    |
| ------------------------------------- | ------------------------------------ |
| wallets                               | 31                                   |
| `sum(main)+sum(bonus)=sum(total)`     | 1（true）                            |
| payment_orders                        | 215                                  |
| completed / credits_added             | 44 / 44                              |
| ledger `reference_type=payment_order` | 45（**0** 个重复 `reference_id` 组） |
| ledger refund rows                    | 11                                   |
| notifications / settings / checkins   | 62 / 26 / 94                         |

45 对 44 的差额不读取行。不把 `payment_order` 做成跨 entry_type 的唯一键：月卡 `vip_bonus` 也将使用 `reference_type=payment_order`。改为 `entry_type='recharge'` 与 `entry_type='vip_bonus'` 两条部分唯一索引。

## 2. 新对象归属

| 对象                  | Schema           | 判定                 | 不变量                                                            | 权威写入                     | 生命周期               | 消费者                  | 跨 schema                      |
| --------------------- | ---------------- | -------------------- | ----------------------------------------------------------------- | ---------------------------- | ---------------------- | ----------------------- | ------------------------------ |
| `vip_memberships`     | billing          | 付费时长权益投影     | `valid_until > now()` 才有效；续费 `greatest(now(), valid_until)` | `complete_payment_order`     | 随用户；已售不可删     | T3 status / 签到 / 提醒 | FK → `app_core.users`          |
| `vip_purchase_grants` | billing          | 订单只履约一次的审计 | `order_id` PK                                                     | 同上                         | 永久                   | 支付对账                | FK → `payment_orders`、`users` |
| `feature_free_trials` | billing          | 免费权益事实         | ordinal 1..3；released 不占 used；`reference_id` 唯一             | reserve/consume/release RPC  | 上线后成功事实，不回溯 | 媒体子任务              | FK → `users`                   |
| `wallet_refunds`      | billing          | 原路退款幂等         | `refund_key` 唯一；一个 debit 最多一次成功退款                    | `refund_wallet_debit`        | 永久                   | T4 补偿                 | FK → `wallet_ledger`、`users`  |
| payment_orders 新列   | billing          | 商品快照             | credits 历史兼容；vip 不能写入 main credits                       | 下单（T3）/ 履约 RPC         | 随订单                 | 四路结算                | 无新 FK                        |
| notifications 新列    | miniapp_features | 提醒去重与动作       | 非空 `business_key` 唯一；kind 仅 `vip_expiry`                    | `insert_vip_expiry_reminder` | 随消息                 | T6                      | 函数读 billing 会员            |
| `vip_entry_seen_at`   | app_core         | 长期用户偏好         | 首次点击后非空，不因过期清空                                      | T3 mark-seen                 | 随用户                 | VIP 角标                | 无                             |

拒绝：第三个钱包、`app_core.user_settings`、媒体 attempt 列、`pg_cron`、改签到 40→60。

## 3. 内部 RPC 与权限

| 函数                                                 | 安全                               | EXECUTE                            | 备注                                                                 |
| ---------------------------------------------------- | ---------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `billing.apply_wallet_debit`                         | DEFINER + `search_path=pg_catalog` | postgres, service_role             | 不暴露给客户端。策略由可信调用方传入。余额不足 `RAISE`，整事务回滚。 |
| `billing.refund_wallet_debit`                        | 同上                               | 同上                               | 按原 `main_delta`/`bonus_delta` 绝对值恢复。                         |
| `billing.complete_payment_order(text,text,text)`     | 补 search_path；**REVOKE PUBLIC**  | postgres, service_role             | 旧两参因 DEFAULT 仍可用。                                            |
| `billing.reserve/consume/release_feature_free_trial` | 同上                               | 同上                               | user+feature advisory lock。                                         |
| `miniapp_features.claim_daily_checkin`               | 补 search_path                     | **保持** PUBLIC/anon/authenticated | 不改金额。                                                           |
| `miniapp_features.insert_vip_expiry_reminder`        | DEFINER + search_path              | postgres, service_role             | `Asia/Shanghai` 日期窗；`business_key` 去重。                        |

Backend `getSupabaseClient()` 使用 **service_role**，收回 `complete_payment_order` 的 PUBLIC EXECUTE 不会断四路结算。

## 4. 锁与容量

- 表规模：wallets 31、orders 215、ledger ~900。`ADD COLUMN ... DEFAULT` 常量在 PG 11+ 不 rewrite。CHECK/INDEX 可在短 `lock_timeout=5s` 内完成。
- 不使用 `CREATE INDEX CONCURRENTLY`（不能放在事务里）。
- 钱包扣退锁钱包行；VIP 履约锁订单行再锁会员行；免费次数 `pg_advisory_xact_lock(user, feature)`；签到 `pg_advisory_xact_lock` + 已有 checkin `FOR UPDATE`。
- Production 结构未知。test 通过不能当作 Production 前置。

## 5. Migration 文件与依赖

1. `20260921_vip_billing_schema.sql` — 表/列/约束/索引/RLS/config。无业务 fixture。
2. `20260921_wallet_debit_refund.sql` — 依赖 1。
3. `20260921_vip_payment_fulfillment.sql` — 依赖 1（及 grant_bonus_credits）。
4. `20260921_feature_free_trial_checkin_reminder.sql` — 依赖 1。

2 与 3、4 无互相依赖，但正式 test 仍必须**一次一个文件**按 1→2→3→4。文件 1 与文件 3 之间不要创建 VIP 订单（旧 `complete_payment_order` 还不会写会员）。

## 6. 不在本轮做的事

- 不 apply test，不访问 Production。
- 不改 `charge_llm_usage` / 语音 / 图片结算。
- 不把签到基础奖励改为 60。
- 不创建 Railway Cron，不发送通知。
- 不收回 `user_wallets`/`payment_orders` 的历史 anon 表 ACL。

## 7. 本轮复核（2026-09-21 21:47+08，停在 test apply 前）

再次确认 MCP `get_project_url` = `https://zoqelpfhurwehlvypryl.supabase.co`，PostgreSQL 17.6，VIP 表/RPC 仍不存在，`pg_cron` 未安装。只读 catalog，未读业务行。

| 复核项                                                 | 结果                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `wallet_ledger_entry_type_check` 名称                  | 与 migration DROP/ADD 一致                                                            |
| recharge `reference_id` 重复组                         | 0；可建 `uq_wallet_ledger_recharge_payment_order`                                     |
| refund `reference_id` 重复组                           | 0                                                                                     |
| `complete_payment_order` ACL                           | `{=X/postgres, postgres, service_role}`，即 PUBLIC EXECUTE。文件 3 必须 REVOKE PUBLIC |
| `claim_daily_checkin` ACL                              | PUBLIC + anon + authenticated + service_role。文件 4 不得收回                         |
| `grant_bonus_credits`                                  | 已 REVOKE PUBLIC，`search_path=pg_catalog`                                            |
| `payment_orders` VIP 列                                | 仍不存在                                                                              |
| `notifications` kind/business_key/action_path/metadata | 仍不存在                                                                              |
| `miniapp_user_settings.vip_entry_seen_at`              | 仍不存在                                                                              |
| `wallet_ledger.debit_key`                              | 仍不存在                                                                              |
| voice 现网 ledger `entry_type`                         | `chat_debit`（105），T2 扣款原语允许 `chat_debit`/`image_generation`                  |

官方文档本轮仍适用：`SECURITY DEFINER` 固定 `search_path`、schema-qualify、`REVOKE EXECUTE FROM PUBLIC`；启用 RLS 不会自动建 policy。changelog 无迫使改锁策略的条目。

实现时额外修复：

1. VIP 履约先锁会员再更新钱包，避免与签到死锁。
2. `consume_feature_free_trial` 先回收过期 reservation，迟到成功不得 consumed。
3. debit/refund 校验 user/debit_key，并捕获 `unique_violation` 做成幂等返回。
4. 文件 3 回补窗口期内旧 RPC 造成的 `fulfillment_applied <> credits_added`。
5. 扣款金额拒绝非整数，与 T1 契约对齐。
   )
