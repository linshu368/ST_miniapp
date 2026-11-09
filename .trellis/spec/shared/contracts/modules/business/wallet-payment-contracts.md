---
module_id: shared.business.wallet-payment-contracts
title: 钱包与支付契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 钱包与支付契约

## 职责与边界

定义余额、消费、签到、套餐、订单、结算来源和支付状态。

## 当前状态

Backend 与 Frontend 已统一使用。`PaymentOrder.settled_by` 已作为兼容扩展透出。

## 入口与调用者

由钱包/支付 routes 和 hooks 消费。

## 涉及文件

| 路径                                 | 职责     |
| ------------------------------------ | -------- |
| `packages/shared/src/api/wallet.ts`  | 钱包 DTO |
| `packages/shared/src/api/payment.ts` | 支付 DTO |

## 关键实现链路

请求 schema → Backend handler/usecase → response schema → Frontend hooks。

## 数据、契约与外部依赖

类型层不含支付 secret 或数据库 row。

## 关键节点与约束

金额精度、订单终态和 settled_by 联合值必须兼容。订单详情与列表使用同一 `toPaymentOrder()` 映射。telemetry 事件不得携带聊天正文、`pay_url` 或 initData。

## 验证方式

Shared tests 与 Backend/Frontend typecheck。

## 已知缺口与待核验项

新增网关字段需保持供应商细节在服务端。

## 关联模块

`backend.business.wallet-payment`、`frontend.business.wallet-payment`。

## 变更记录

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## 支付供应商替换为 Vexutopia（2026-11-03）

删除 `POST /api/payment/orders/:id/checkout-confirmations` 的 `CheckoutConfirmation*` / `PostCheckoutConfirmation*` schema 与类型。`CreatePaymentOrderData.pay_url` 现在固定是 https 托管收银台地址；其余订单契约不变，`settled_by` 联合值保留 `return` 以兼容历史订单。

## VIP 混合星尘奖励（2026-11-05）

VipCheckinBonusConfig 支持旧整数或严格 {bonus_credits,main_credits}；VipPlanTerms 增可选 bonus_main_credits，历史缺省 0。订单 DTO、VIP benefits、签到 DTO 提供通用额度并保留原总额字段。

隔离 PG 覆盖并发、幂等、旧订单及故障回滚；远端执行与部署状态见任务 `11-05-vip-mixed-rewards` 的发布记录。

## TTZF epay contracts (2026-11-09)

EpayNotificationSchema, EpayCreateResponseSchema and EpayQueryResponseSchema define provider data in api/payment.ts before backend consumption. Notification preserves string extension fields for signing; duplicate raw query fields are rejected before schema parsing. Optional param is not required or used as an environment guard; legacy signed param remains covered by signature verification. New provider IDs require EP + 30 lowercase hex digits. Numeric code/status and string yuan amounts are enforced; the backend additionally checks merchant/local-order identity, channel/reference and exact cents. Consumer PaymentOrder/CreatePaymentOrderData stay unchanged; pay_url remains HTTPS, not a QR image or application scheme. No provider secret reaches the browser.

Telemetry sanitization covers key, appKey, sign, clientip, buyer and full notification/return query strings, including standalone Sentry spans. A task-specific explicit user instruction selects the documented server GET query; never emit its credential-bearing URL. Contract/telemetry regressions are in epay-contracts.test.ts; final verification status is in the task record.
