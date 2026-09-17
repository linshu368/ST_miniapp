---
module_id: backend.business.wallet-payment
title: 钱包、签到与充值支付
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/09-11-package-spec-module-sync/
last_verified_at: 2026-09-11
---

# 钱包、签到与充值支付

## 职责与边界

负责余额/消费查询、签到奖励、充值订单、支付回调与对账结算。

## 当前状态

支付 webhook/return/query/cron 四路结算已统一到幂等出口；bonus 星尘发放统一由数据库 `billing.grant_bonus_credits` 完成，充值 `main_credits` 不走该入口。

## 入口与调用者

Frontend 钱包/订单页、支付网关和 Railway 支付任务调用。

## 涉及文件

| 路径                                     | 职责       |
| ---------------------------------------- | ---------- |
| `packages/backend/src/routes/wallet.ts`  | 钱包与签到 |
| `packages/backend/src/routes/payment.ts` | 支付 API   |
| `packages/backend/src/features/payment/` | 支付用例   |

## 关键实现链路

鉴权/验签 → 订单或钱包用例 → 原子结算 → 流水/余额 → DTO。

## 数据、契约与外部依赖

依赖 billing 域、支付网关和 shared wallet/payment 契约。

## 关键节点与约束

订单、流水、余额口径分离；支付结算以 `credits_added`/业务键幂等；应用层禁止手动修改 bonus 余额。

## 验证方式

Backend payment/wallet tests、对账脚本和 test 支付 smoke。

## 已知缺口与待核验项

支付 remediation 遗留按专项文档推进。

## 关联模块

`frontend.business.wallet-payment`、`shared.business.wallet-payment-contracts`、`database.business.billing-payment`。
