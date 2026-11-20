---
module_id: database.business.billing-payment
title: 钱包、订单与生成计费数据
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/11-19-payment-unpaid-stop-noise/
last_verified_at: 2026-11-19
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

## 历史：可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

## 客户端首字交付 v4（2026-10-28）

新客户端用 `client_committed_v4` 替换屏幕可见检测：提交动作 → 本轮正文或已开启的公开思考首次提交到 React 消息界面状态。它是业务侧交付口径，不是像素/阅读证明。滚动位置、气泡是否在视口、思考是否折叠均不参与；received 仅供分段排查，不能取消截止。提交时间达到当轮 deadline 即归超时，计时器延迟不能变成超时后的成功。

send/regenerate 携带可选 `first_token_measurement`；后端通过既有 begin RPC 的同一次 INSERT 写入现有 measurement_method，缺报请求仍属于 v4。每轮首次结果不可改写；离页/后台独立终态，生成仍可继续并在返回时恢复。迟到回复可展示但不改写已超时记录。旧 v1-v3 保留兼容，历史独立筛选。

统计复用现有 first_token_visible_ms 列承载按版本定义的时长，不增加表、cron、轮询或逐 token 写入。主指标为前台已知结果的无字时间截断率；成功分布只取截止前已交付样本，离页/缺报及覆盖率同时显示。后台和缺报不能当成功，不用服务端或供应商 latency 填补客户端数据。4秒首发、2秒兜底、10秒总预算和1%目标不因换口径调整。

系统超时免费、免费预留释放；主动停止沿原报价/权益一次结算。计费继续用一次交付结果和服务端持久化终态保障正确性，不依赖滚动/阅读。已结算记录只补调用元数据，不重进计费；归档明细依永久去重返回显式 archived 终态，不重扣、不伪造账单；failed 进入已有有界退避。缺报沿用原预算+15秒保守收口，不增加新计费任务。

迁移为 `20261028_client_committed_first_token.sql`、`20261028_llm_archived_charge_result.sql`，均仅替换既有函数，保留 ACL 和历史数据。先 TEST 验证、合 dev，再生产迁移 → Backend → Frontend/看板。发布证据见任务 release-review；1%是否达成须由上线后的 v4 样本判断。

## 支付供应商替换为 Vexutopia（2026-11-03）

无迁移。`payment_orders.provider_transaction_id` 改为建单成功即写入 Vexutopia `tx_…`（`complete_payment_order` 的 `COALESCE` 写法兼容）。`next_reconcile_at`/`reconcile_attempts`/`reconcile_locked_until` 与 `checkout_*` 列、`record_checkout_confirmation` RPC 不再被调用，按约定保留不删。`payment_operation_events` 写入改为按 `event_key` 冲突忽略，便于对账把同一异常只记一次。

## VIP 混合星尘奖励（2026-11-05）

20261105_vip_mixed_rewards.sql 增订单/开卡审计通用赠送快照，旧值为 0；grant_vip_reward 复用 canonical 专项发放并原子更新通用余额及同一条 ledger。保留订单唯一约束、北京零点签到边界、原锁与幂等；赠送不计实付收入。先 test 后 production，应用部署完成后再发布拆分配置。回退先还原配置，保留混合结算能力直至在途订单结束，不回收已发奖励。

隔离 PG 覆盖并发、幂等、旧订单及故障回滚；远端执行与部署状态见任务 `11-05-vip-mixed-rewards` 的发布记录。

## TTZF epay repository behavior (2026-11-09)

No new schema objects or migrations. Existing billing.payment_orders and complete_payment_order remain the authoritative atomic fulfilment boundary. New EP-prefixed IDs isolate provider traffic from historical MA orders. attachProviderTransaction binds only null references on pending/expired rows and rereads after a racing update; an existing different reference is never overwritten. markFailed only changes pending rows without a provider reference, protecting early callbacks.

The historical note that next_reconcile_at is unused is superseded: bounded reconciliation selects due EP orders (including null references), sorts by next_reconcile_at/id and rotates candidates before querying. Existing lease/attempt columns remain unused. Expiry no longer bulk-closes unknown or legacy outcomes. Refunds do not automatically change wallet/VIP balances. Repository mocks cover CAS/query predicates; actual RPC concurrency/rollback and target-environment schema verification remain for engineering TEST acceptance. No remote database was accessed for this change.

## 自动支付查单停查（2026-11-19，本地候选）

### Scope / Trigger

fast_reconcile 与 expiry_reconcile 共用；超过创建后 8 小时不再派发，到期后累计 3 次明确 unpaid 停查。迁移/发布状态分别核对，源码不等于线上生效。

### Signatures

`billing.claim_payment_reconcile_jobs(timestamptz,timestamptz,integer,integer,integer) RETURNS SETOF billing.payment_orders` ABI 不变；新增 `billing.record_payment_reconcile_unpaid(p_order_id text,p_claimed_at timestamptz) RETURNS TABLE(confirmations integer,stopped boolean,recorded boolean)`。

### Contracts

计数和 last_unpaid_claim_at 属 billing.payment_reconcile_jobs（J），0..3；服务端 RPC 独占写入，先锁订单再锁任务。必须匹配 last_attempt_at，同键只增一次。claim 的 DB 窗口最少限制到 p_now-8h、过滤计数 3，保留 30s·2^n/7200s 上限及 SKIP LOCKED。停查行保留至超龄/终态清理。ops.payment_events 仅在迁移中按当前窗口、到期后、自动 gateway/unpaid 有界回填，每单 LIMIT 3；不进产品路径。无新公开 API/配置或环境变量。

### Validation & Error Matrix

到期前/旧领取/重放/已履约/超龄/缺任务均不增计数；失败/超时/未知响应不算 unpaid。计数 RPC 限时 5 秒，失败继续 error，不宣称停查。只有后台 query 的 provider*unavailable/network/timeout/rate_limited 显式 warn，事实仍 failed/unknown；配置、响应非法、金额不符、DB 与结算保留 error。保留 ops 与既有支付告警。单一业务摘要的 \*Count 必须为数值（布尔 failedCount 会被日志投影丢弃），安全 code 仅允许数字或 HTTP*数字，禁原始 msg/URL。

### Good / Base / Bad Cases

正常待付轮转；到期后第 1/2 次继续、第 3 次停；失败夹在有效 unpaid 中不计数。派发前再核 8 小时，已经派出的已付结果仍允许幂等结算。验签回调/用户主动查询不受自动停查限制，不能删订单或回滚钱包来降低噪声。

### Tests Required

既有 PaymentReconciliation、PaymentOperationEvents、repository、网关/结算/告警测试；test-db-reorg-p4a-migration.sh 验证 8 小时 DB 夹紧、历史过滤、重放/旧领取、双会话计数、回调交错、service-only ACL 及 claim 回退/前向恢复。目标 TEST/生产验收与迁移顺序见 migrations/README；本地隔离 PG 证据不替代远端实况。

### Wrong vs Correct

错误：把 attempts 当未付次数，或把外呼失败写成 unpaid/成功以消除 error。正确：只有明确 unpaid 且已到期才按当前领取 CAS 递增；真实失败事实保留，按恢复性调整日志等级。先迁移后部署两个任务，保留资金恢复入口。
