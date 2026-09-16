---
module_id: frontend.business.wallet-payment
title: 钱包、签到与充值
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 钱包、签到与充值

## 职责与边界

展示余额、消费、签到、充值套餐、订单状态和支付回跳。

## 当前状态

钱包与支付页面已使用统一 API hooks；结算真相在服务端。

## 入口与调用者

用户从个人中心进入钱包/充值流程。

## 涉及文件

| 路径                                                 | 职责       |
| ---------------------------------------------------- | ---------- |
| `packages/frontend/src/app/(main)/profile/recharge/` | 充值页面   |
| `packages/frontend/src/app/(main)/profile/orders/`   | 订单页面   |
| `packages/frontend/src/app/(main)/profile/spending/` | 消费页面   |
| `packages/frontend/src/lib/api/free-quota.ts`        | 额度 hooks |
| `packages/frontend/src/lib/api/payment.ts`           | 支付 hooks |

## 关键实现链路

套餐/余额 query → 创建订单 → 外部支付 → 订单轮询/回跳 → 缓存刷新。

## 数据、契约与外部依赖

消费 shared wallet/payment 契约、Backend 和外部支付页。

## 关键节点与约束

前端轮询不执行入账真相；支付成功后以服务端订单/余额为准。

## 验证方式

Frontend tests/build 与 test 支付人工 smoke。

## 已知缺口与待核验项

WebView 回跳和第三方页面兼容需真机验证。

## 关联模块

`backend.business.wallet-payment`、`shared.business.wallet-payment-contracts`。
