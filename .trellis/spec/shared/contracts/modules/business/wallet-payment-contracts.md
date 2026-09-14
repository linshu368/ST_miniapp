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

Backend 与 Frontend 已统一使用。

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

金额精度、订单终态和 settled_by 联合值必须兼容。

## 验证方式

Shared tests 与 Backend/Frontend typecheck。

## 已知缺口与待核验项

新增网关字段需保持供应商细节在服务端。

## 关联模块

`backend.business.wallet-payment`、`frontend.business.wallet-payment`。
