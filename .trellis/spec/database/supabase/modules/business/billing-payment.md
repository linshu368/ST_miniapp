---
module_id: database.business.billing-payment
title: 钱包、订单与生成计费数据
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/10-27-recoverable-chat-delivery/
last_verified_at: 2026-10-27
---

# 钱包、订单与生成计费数据

## 职责与边界

维护 billing 域订单、钱包、流水、免费额度及 LLM/语音计费原子函数。

## 当前状态

支付结算、钱包流水和生成计费对象已在迁移链定义；图片仅在 Storage 元数据齐全后通过 `billing.settle_image_generation` 原子扣款、写 ledger 并置 current ready。六类 bonus 发奖仍统一收口到 `billing.grant_bonus_credits`。

## 入口与调用者

Backend payment、wallet、generation 和 voice repositories/RPC 使用。
维护 billing 域订单、钱包、流水、免费额度及 LLM/语音/图片计费原子函数。

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

## 图片创作广场 V2（2026-10-12）

`billing.settle_image_plaza_generation` 在同一事务内校验任务、扣减钱包并写 ledger；`billing.share_image_plaza_artifact` 原子创建公开作品、记录首次分享事实与返利，重复/并发请求返回既有事实且不重复奖励。

`20261013_image_plaza_seed_catalog.sql` 前向重建 `billing.share_image_plaza_artifact`：分享奖励只调用 canonical `billing.grant_bonus_credits`，不再直接更新钱包；`civitai_seed` artifact 被明确拒绝进入分享返利链。数据库行为仍需在 test 环境验证。

## 变更记录

- 2026-10-13：任务 `10-10-image-plaza-v2` 将分享奖励收敛到 canonical grant RPC，并排除种子 artifact。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## 主动停止原价与权益结算（2026-10-26）

取消请求显式区分user_stop与first_token_timeout。新业务标记user_cancelled在已冻结报价的生成中按原型号原价格/VIP/免费权益一次结算；免费轮消费免费次数，前端不增加扣费通知。系统超时、上游失败、历史cancelled和未报价取消保持免扣；新请求服务端策略位默认生效，取消CAS RPC按截止与已见观测裁决，不以调用方省略原因选价。免费权益先收口再解锁，钱包按原charge_id后台结算，缺generationId也不重发上游；回捞保留新业务原因及同账单幂等。契约/后端/数据库/前端联动，具体执行证据见本任务release-review。


## 可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。
