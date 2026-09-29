# T3 Backend 复用核验

日期：2026-09-22。分支 `dev_vip_0920`。只读代码与 T1/T2 产物，未改历史 migration。

## 1. 现有主人与扩展决定

| 能力           | 现有主人                                                                                                                                       | 决定                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Feature 组织   | `routes → features/usecases/domain → infrastructure/repositories`                                                                              | 新增 `features/vip` 做资格映射；持久化放 `MiniappVipRepository`。不建第二套 Fastify、鉴权或 Supabase client               |
| 鉴权用户       | `requireTelegramAuth` + `getOrCreateDbUser(request.user)`                                                                                      | VIP/钱包/支付继续只用这个内部 user id。不接受客户端 user id 或客户端 VIP 状态                                             |
| 支付计划       | `rechargeRules.ts` 读 `miniapp_payment_plans`                                                                                                  | `plans` 仍是星尘套餐。VIP 周/月条款只用 Shared `VIP_PLAN_COMMERCIAL_TERMS`，不放进可被运营改价的套餐 JSON                 |
| 下单           | `RechargeUseCase.createOrder`                                                                                                                  | 扩展商品快照与网关商品名。credits 网关名保持 `VIP会员`                                                                    |
| 四路确认       | webhook/return → `settlePaidOrder(..., source)`；query → `reconcileWithGateway`；cron → `FastPaymentReconciliation` 同样进入 `settlePaidOrder` | 不在各 route 写会员或余额。数据库出口仍是已部署的 `billing.complete_payment_order(text,text,text)`                        |
| 履约返回       | repository `rpc` 后 `toPaymentOrder`                                                                                                           | 映射 `product_type`、`product_id`、`fulfillment_applied`、`vip_duration_days`、`vip_bonus_credits`、`vip_valid_until`     |
| 支付通知       | `insertUserNotification`，失败只记 `{ err }`                                                                                                   | 按订单快照生成周卡/月卡/星尘文案。失败不回滚履约                                                                          |
| 邀请首付       | `checkInviteFirstPaidReward` → `miniapp_traffic.check_invite_first_paid_reward`                                                                | 应用层继续无条件调用。见下方冲突，本轮不改该 RPC                                                                          |
| 钱包           | `MiniappWalletRepository.toWalletBalance`                                                                                                      | 已有 `main/bonus/total` 与 `credits`。本轮收紧为 `credits = total = main + bonus`，不一致则失败，不拼一个假余额           |
| 签到           | `claim_daily_checkin` + `getDailyCheckinStatus`                                                                                                | 发放仍只走该 RPC。预览与 RPC 使用同一公式：基础额来自配置，有效 VIP 再加同等基础额，一次 `grant_bonus_credits`            |
| Runtime config | `platform/runtime-config.ts` 的 `fetchRuntimeConfigEntry`                                                                                      | 新开关 `vip_purchase_enabled` 走这个入口。读取失败视为 false。既有支付套餐读取保持原 `rechargeRules` 路径，不平行再包一层 |
| Route 注册     | `app.ts` `app.register`                                                                                                                        | 增加 `vipRoutes`。每条注册旁保留 `@frontend-ready: true`                                                                  |
| 测试           | Vitest mock repository/gateway；支付 SQL 用 `scripts/test-vip-billing-migrations.sh` 的一次性本地库                                            | 扩展现有用例。不连正式 test，不创建真实微信支付                                                                           |
| 日志           | `requestLogger` / `createLogger`，错误 `{ err }`                                                                                               | 只加 operation、内部 id、商品、source、履约摘要、奖励、耗时                                                               |

拒绝：第二套支付网关、内存 VIP 缓存、route 内更新 `vip_memberships` 或钱包、把 0.88 写回任何计价常量、改语音/图片、启用购买或提醒开关。

## 2. 签到 60 的权威入口

| 层             | 事实                                                                                                            | 标签                              |
| -------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 发放           | `miniapp_features.claim_daily_checkin` 读取 `app_core.runtime_config.key = miniapp_daily_checkin_bonus_credits` | `MIGRATION` + `TEST-DB` 当前值 40 |
| 缺失兜底       | T2 函数 `COALESCE(..., 10)`                                                                                     | `MIGRATION`                       |
| 展示兜底       | `MiniappWalletRepository` 解析失败时用 40                                                                       | `REPO`                            |
| Admin 表单默认 | `configMetadata.miniapp_daily_checkin_bonus_credits.defaultValue = 40`                                          | `REPO`                            |
| 产品目标       | 普通 60；有效 VIP 再 +60，合计 120，一次入账                                                                    | `PRD`                             |

T2 函数在读到 VIP 后仍把 `vip_reward_credits` 写成 0，注释写明留给 T3。只把配置改成 60 不会产生 120。本轮新增 `20260922_daily_checkin_vip_bonus.sql`：把该 key 设为 60，并替换函数体。有效条件仍是同一个 `now()` 快照下 `valid_until > now()`。VIP 加成等于当时的基础配置额，因此 60 的配置得到 60/120。

不改 T2 已 apply 的四个文件。不收回 `claim_daily_checkin` 的历史 anon/authenticated EXECUTE；这仍是既有安全债务，不阻碍 service role 调用。

Supabase 文档（Database Functions / JavaScript `rpc`）确认：`schema().rpc(name, { arg })` 调用 Postgres 函数；`SECURITY DEFINER` 必须固定 `search_path`，空 search path 时关系必须带 schema。现有 `getDomainDb('miniapp_features').rpc('claim_daily_checkin', { p_user_id })` 与 `getDomainDb('billing').rpc('complete_payment_order', …)` 已是这个形态，参数名与 T2 签名一致，不新增重载。

## 3. 邀请首付

`109_invite_first_paid_reward.sql` 原来只认 `credits_added IS TRUE`。T2 的 VIP 履约把该列留为 false，改用 `fulfillment_applied`，所以 VIP 现金购买会得到 `not_settled`。

2026-09-22 已批准 forward-fix，不改 109。新文件 `20260922_invite_first_paid_vip_fulfillment.sql` 把「已入账现金支付」改成：

- `fulfillment_applied`，或
- 非 VIP 商品的 `credits_added`

同一订单重放仍由 `invite_reward_logs` 和 `grant_invite_reward` 唯一键去重。规则金额和开关不动。本地场景已覆盖 VIP 首笔发放、同一订单重放、更早的 credits 支付之后再买 VIP、未履约 VIP，以及只带 `credits_added` 的历史星尘订单。正式 test 尚未 apply。

## 4. 发布顺序

1. 先把包含两份 T3 migration 的提交推到远程 `dev_vip_0920`。GitHub Actions 只 checkout 所选远程分支，看不到未推送的本地文件。
2. 对正式 test 各 apply 一次，两个文件互不依赖，都排在四个 T2 文件之后：
   - `20260922_daily_checkin_vip_bonus.sql`
   - `20260922_invite_first_paid_vip_fulfillment.sql`
3. 签到文件 apply 并只读复核后，再发布本轮 Backend。若 Backend 先于该文件上线，签到预览会按 60/120 计算，而线上 RPC 仍按 40 且 VIP 加成为 0。
4. 不在本窗口启用 `vip_purchase_enabled` 或 `vip_reminders_enabled`。
5. Production 配置值仍未核。签到 migration 会把目标库的基础额写成 60，不得在未单独确认前对 Production 执行。邀请 forward-fix 同样不得对 Production 执行。
