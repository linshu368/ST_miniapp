---
module_id: backend.business.wallet-payment
title: 钱包、签到与充值支付
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/10-28-client-ready-first-token/
last_verified_at: 2026-10-28
---

# 钱包、签到与充值支付

## 职责与边界

负责余额/消费查询、签到奖励、充值订单、支付回调与对账结算。

## 当前状态

支付 webhook/return/query/cron 四路结算已统一到幂等出口；bonus 星尘发放统一由数据库 `billing.grant_bonus_credits` 完成，充值 `main_credits` 不走该入口。支付套餐页面把套餐、充值页、支付提示和余额不足文案合并为一次 runtime-config 批量读取，再与 VIP 策略并行；创建订单仍独立读取权威套餐，不复用页面快照。

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

订单、流水、余额口径分离；支付结算以 `credits_added`/业务键幂等；应用层禁止手动修改 bonus 余额。批量页面配置中套餐缺失或损坏仍 fail closed，非关键页面文案/样式保持安全默认，不能用进程缓存延长价格配置陈旧窗口。

## 验证方式

Backend payment/wallet tests、runtime-config 批量读取与 fallback 测试、对账脚本和 test 支付 smoke。

## 已知缺口与待核验项

支付 remediation 遗留按专项文档推进。

## 关联模块

`frontend.business.wallet-payment`、`shared.business.wallet-payment-contracts`、`database.business.billing-payment`。

## 图片创作广场 V2（2026-10-12）

图片广场按有效报价快照结算，只有图片转存成功后才由数据库 RPC 原子扣减钱包；同一 attempt 重放不得重复扣费。首次分享按实扣星尘乘运行时比例返还，artifact 唯一约束和 reward ledger 保证并发幂等。

`20261013_image_plaza_seed_catalog.sql` 前向重建分享 RPC，使首次分享奖励只经 `billing.grant_bonus_credits` 发放并拒绝种子 artifact 进入用户分享返利链；真实数据库升级和并发验证仍待明确 test 目标。

视频使用 `billing.reserve_media_plaza_video` 预扣、终态失败用 `refund_media_plaza_video` 幂等退款；按用户 advisory lock 限制同时进行中的任务数。图片与视频分享共用首次分享完成字段，视频 seed 不产生扣费或返利。上述 RPC 仅存在于待执行的 `20261027_media_plaza_video.sql`，本地代码完成不代表 test/production 已生效。

## 变更记录

- 2026-10-27：任务 `10-27-sentry-performance-optimization` 将 `/api/payment/plans` 的四条同表配置读取合并为一次批量读取，订单权威读取保持独立。
- 2026-10-13：任务 `10-10-image-plaza-v2` 收敛分享奖励写入口并隔离种子作品。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## 客户端首字交付 v4（2026-10-28）

新客户端用 `client_committed_v4` 替换屏幕可见检测：提交动作 → 本轮正文或已开启的公开思考首次提交到 React 消息界面状态。它是业务侧交付口径，不是像素/阅读证明。滚动位置、气泡是否在视口、思考是否折叠均不参与；received 仅供分段排查，不能取消截止。提交时间达到当轮 deadline 即归超时，计时器延迟不能变成超时后的成功。

send/regenerate 携带可选 `first_token_measurement`；后端通过既有 begin RPC 的同一次 INSERT 写入现有 measurement_method，缺报请求仍属于 v4。每轮首次结果不可改写；离页/后台独立终态，生成仍可继续并在返回时恢复。迟到回复可展示但不改写已超时记录。旧 v1-v3 保留兼容，历史独立筛选。

统计复用现有 first_token_visible_ms 列承载按版本定义的时长，不增加表、cron、轮询或逐 token 写入。主指标为前台已知结果的无字时间截断率；成功分布只取截止前已交付样本，离页/缺报及覆盖率同时显示。后台和缺报不能当成功，不用服务端或供应商 latency 填补客户端数据。4秒首发、2秒兜底、10秒总预算和1%目标不因换口径调整。

系统超时免费、免费预留释放；主动停止沿原报价/权益一次结算。计费继续用一次交付结果和服务端持久化终态保障正确性，不依赖滚动/阅读。已结算记录只补调用元数据，不重进计费；归档明细依永久去重返回显式 archived 终态，不重扣、不伪造账单；failed 进入已有有界退避。缺报沿用原预算+15秒保守收口，不增加新计费任务。

迁移为 `20261028_client_committed_first_token.sql`、`20261028_llm_archived_charge_result.sql`，均仅替换既有函数，保留 ACL 和历史数据。先 TEST 验证、合 dev，再生产迁移 → Backend → Frontend/看板。发布证据见任务 release-review；1%是否达成须由上线后的 v4 样本判断。
