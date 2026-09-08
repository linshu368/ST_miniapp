---
module_id: database.business.billing-payment
title: 钱包、订单与生成计费数据
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 钱包、订单与生成计费数据

## 职责与边界

维护 billing 域订单、钱包、流水、免费额度及 LLM/语音计费原子函数。

## 当前状态

支付结算、钱包流水和生成计费对象已在迁移链定义。

## 入口与调用者

Backend payment、wallet、generation 和 voice repositories/RPC 使用。

## 涉及文件

| 路径                                                      | 职责         |
| --------------------------------------------------------- | ------------ |
| `packages/shared/migrations/103_payment_settled_by.sql`   | 结算来源     |
| `packages/shared/migrations/105_voice_billing_atomic.sql` | 语音原子计费 |

## 关键实现链路

业务幂等键 → 订单/用量行锁 → wallet ledger → user_wallets 当前余额。

## 数据、契约与外部依赖

billing 是资金权威域；支付供应商状态由 Backend 适配。

## 关键节点与约束

订单金额、流水变动、当前余额必须分口径；生产 migration 独立执行。

## 验证方式

Test migration shape/RPC、Backend 计费与支付回归。

## 已知缺口与待核验项

语音计费的 test/production 执行状态必须分别核验。

## 关联模块

`backend.business.wallet-payment`、`backend.business.conversation-generation`。
