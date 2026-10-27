---
module_id: backend.business.wallet-payment
title: 钱包、签到与充值支付
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-13
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

## 图片创作广场 V2（2026-10-12）

图片广场按有效报价快照结算，只有图片转存成功后才由数据库 RPC 原子扣减钱包；同一 attempt 重放不得重复扣费。首次分享按实扣星尘乘运行时比例返还，artifact 唯一约束和 reward ledger 保证并发幂等。

`20261013_image_plaza_seed_catalog.sql` 前向重建分享 RPC，使首次分享奖励只经 `billing.grant_bonus_credits` 发放并拒绝种子 artifact 进入用户分享返利链；真实数据库升级和并发验证仍待明确 test 目标。

视频使用 `billing.reserve_media_plaza_video` 预扣、终态失败用 `refund_media_plaza_video` 幂等退款；按用户 advisory lock 限制同时进行中的任务数。图片与视频分享共用首次分享完成字段，视频 seed 不产生扣费或返利。上述 RPC 仅存在于待执行的 `20261027_media_plaza_video.sql`，本地代码完成不代表 test/production 已生效。

## 变更记录

- 2026-10-13：任务 `10-10-image-plaza-v2` 收敛分享奖励写入口并隔离种子作品。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
