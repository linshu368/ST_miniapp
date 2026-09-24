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

Backend 与 Frontend 已统一使用。`PaymentOrder.settled_by` 已作为兼容扩展透出；replay context / PostHog 事件形状在 `api/telemetry.ts`，含允许无 `replay_context_id` 的 `recharge_entry_clicked`，本期不含 `user_cohort`。

## 入口与调用者

由钱包/支付 routes 和 hooks 消费。

## 涉及文件

| 路径                                   | 职责                  |
| -------------------------------------- | --------------------- |
| `packages/shared/src/api/wallet.ts`    | 钱包 DTO              |
| `packages/shared/src/api/payment.ts`   | 支付 DTO              |
| `packages/shared/src/api/telemetry.ts` | replay 事件与 context |

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

- 2026-09-23：任务 `Fix live free quota refresh in chat`（`.trellis/tasks/archive/2026-09/09-23-fix-chat-free-quota-refresh/`）??????????????????????????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
- 2026-09-23：任务 `Admin VIP media configuration`（`.trellis/tasks/archive/2026-09/09-23-admin-vip-media-config/`）Admin ?? VIP ??????????????????/????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
