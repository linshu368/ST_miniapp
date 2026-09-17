---
module_id: database.business.billing-payment
title: 钱包、订单与生成计费数据
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/09-11-chat-image-generation-plan/
last_verified_at: 2026-09-14
---

# 钱包、订单与生成计费数据

## 职责与边界

维护 billing 域订单、钱包、流水、免费额度及 LLM/语音/图片计费原子函数。

## 当前状态

支付结算、钱包流水和生成计费对象已在迁移链定义；图片仅在 Storage 元数据齐全后通过 `billing.settle_image_generation` 原子扣款、写 ledger 并置 current ready。六类 bonus 发奖仍统一收口到 `billing.grant_bonus_credits`。

## 入口与调用者

Backend payment、wallet、generation、voice 和 image repositories/RPC 使用。

## 涉及文件

| 路径                                                                  | 职责               |
| --------------------------------------------------------------------- | ------------------ |
| `packages/shared/migrations/103_payment_settled_by.sql`               | 结算来源           |
| `packages/shared/migrations/105_voice_billing_atomic.sql`             | 语音原子计费       |
| `packages/shared/migrations/20260911_billing_grant_bonus_credits.sql` | bonus 发奖唯一入口 |
| `packages/shared/migrations/20260914_chat_message_images.sql`         | 图片成功原子结算   |

## 关键实现链路

业务 RPC 判定/幂等 → `grant_bonus_credits` 或支付/用量原子函数 → wallet ledger → user_wallets 当前余额；图片结算以 attempt id/reference 唯一约束保证最多扣一次。

## 数据、契约与外部依赖

billing 是资金权威域；支付供应商状态由 Backend 适配。

## 关键节点与约束

订单金额、流水变动、当前余额必须分口径；应用层不得直接增加 `bonus_credits`；生产 migration 独立执行。

## 验证方式

Test migration shape/RPC、Backend 计费与支付回归。

## 已知缺口与待核验项

语音计费及图片迁移的 test/production 执行状态必须分别核验；图片余额竞争、RPC 重放与对象补偿仍需 test 环境证据。

## 关联模块

`backend.business.wallet-payment`、`backend.business.conversation-generation`。
