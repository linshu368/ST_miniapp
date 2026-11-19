---
module_id: backend.business.wallet-payment
title: 钱包、签到与充值支付
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/11-19-payment-unpaid-stop-noise/
last_verified_at: 2026-11-19
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
- 2026-11-10：任务 `Payment availability probe and extensible response strategies`（`.trellis/tasks/archive/2026-11/11-10-payment-availability-probe/`）Added isolated upstream-only payment probe, environment switch, bounded response strategies and extension documentation. Local code remains uncommitted; any archive HEAD reference is the starting baseline only；commit：`042bdc9c08264e4120f7870b049164d118657d58`。
- 2026-11-10：任务 `支付探测自动获取本机IP`（`.trellis/tasks/archive/2026-11/11-10-payment-probe-auto-ip/`）Removed manual probe IP configuration in favor of local IPv4 selection and loopback fallback. Local changes remain uncommitted; archive HEAD is baseline only；commit：`042bdc9c08264e4120f7870b049164d118657d58`。

## 客户端首字交付 v4（2026-10-28）

新客户端用 `client_committed_v4` 替换屏幕可见检测：提交动作 → 本轮正文或已开启的公开思考首次提交到 React 消息界面状态。它是业务侧交付口径，不是像素/阅读证明。滚动位置、气泡是否在视口、思考是否折叠均不参与；received 仅供分段排查，不能取消截止。提交时间达到当轮 deadline 即归超时，计时器延迟不能变成超时后的成功。

send/regenerate 携带可选 `first_token_measurement`；后端通过既有 begin RPC 的同一次 INSERT 写入现有 measurement_method，缺报请求仍属于 v4。每轮首次结果不可改写；离页/后台独立终态，生成仍可继续并在返回时恢复。迟到回复可展示但不改写已超时记录。旧 v1-v3 保留兼容，历史独立筛选。

统计复用现有 first_token_visible_ms 列承载按版本定义的时长，不增加表、cron、轮询或逐 token 写入。主指标为前台已知结果的无字时间截断率；成功分布只取截止前已交付样本，离页/缺报及覆盖率同时显示。后台和缺报不能当成功，不用服务端或供应商 latency 填补客户端数据。4秒首发、2秒兜底、10秒总预算和1%目标不因换口径调整。

系统超时免费、免费预留释放；主动停止沿原报价/权益一次结算。计费继续用一次交付结果和服务端持久化终态保障正确性，不依赖滚动/阅读。已结算记录只补调用元数据，不重进计费；归档明细依永久去重返回显式 archived 终态，不重扣、不伪造账单；failed 进入已有有界退避。缺报沿用原预算+15秒保守收口，不增加新计费任务。

迁移为 `20261028_client_committed_first_token.sql`、`20261028_llm_archived_charge_result.sql`，均仅替换既有函数，保留 ACL 和历史数据。先 TEST 验证、合 dev，再生产迁移 → Backend → Frontend/看板。发布证据见任务 release-review；1%是否达成须由上线后的 v4 样本判断。

## 支付供应商替换为 Vexutopia（2026-11-03）

子千易整体删除（网关、表单回调、诊断脚本、配置）。`infrastructure/payment/VexutopiaPaymentGateway.ts` 负责建单（`Idempotency-Key = order-<本地订单号>`，仅超时/网络/限流/上游 503 重试一次）、单笔查单、批量 lookup 与 Webhook HMAC 验签。建单成功后先写 `provider_transaction_id`，写不进去就标 failed、不交出收银台。入账来源：`webhook`（验签 + `mijing_env` 本环境过滤）、`query`（轮询/回跳单笔查单）、`cron`（`PaymentReconciliation` 每 30 秒 / 5 分钟批量查最近 2 小时未履约订单，平台终态未付则本地提前置 expired）。回跳只导航。`payment.refunded` 只记事件和告警，不自动扣回。收银台确认上报整体删除；告警规则 v3 只读操作事件中的平台直接信号。任务：`.trellis/tasks/11-03-vexutopia-payment/`。

## VIP 混合星尘奖励（2026-11-05）

VIP 签到配置兼容旧数字及专项/通用拆分；报价、结果和 VIP benefits 都提供两钱包额度。创建月卡订单冻结 vip_bonus_main_credits，结算与到账通知读取订单快照；不修改旧订单或历史余额。

隔离 PG 覆盖并发、幂等、旧订单及故障回滚；远端执行与部署状态见任务 `11-05-vip-mixed-rewards` 的发布记录。

## TTZF epay cutover (2026-11-09)

### Scope / Trigger

Replaces retired Vexutopia in new purchases, callbacks, polling and workers. No native API, provider registry or database migration. The preceding Vexutopia section describes historical behavior only.

### Signatures

`EpayPaymentGateway.createPayment({orderId, amount, type, description, clientIp})`; `queryOrder({id, provider_transaction_id, payment_type}, signal?)`; `GET /api/payment/notify/ttzf`; existing order/list/return consumer endpoints remain compatible.

### Contracts

`TTZF_APP_ID` is the application ID; `TTZF_APP_KEY` is its secret; `TTZF_BASE_URL` defaults to https://ttzf8.com/api. `PAYMENT_NOTIFY_URL` and `PAYMENT_RETURN_URL` must be environment-specific HTTPS backend routes. New IDs are EP plus 30 lowercase random hex digits. Creation omits optional param; notification/query processing does not depend on its echo. Isolate environment callback URLs, credentials and databases; notifications require an existing local order. Creation is POST form; query is the user-selected documented GET act=order with credentials sent only to the HTTPS provider, never logged. All transport calls disable redirects; query disables caching. Lowercase MD5 signs raw sorted nonempty fields except sign/sign_type/signType, including legacy param extensions when present. Railway public ingress supplies validated X-Real-IP; local requests use socket IP. Do not expose untrusted direct/private/TCP ingress.

### Validation & Error Matrix

Query-response pid may be omitted/null, as observed in the provider's successful paid response. Validate any non-null pid against the configured application ID; malformed or mismatched values still fail. Request pid/key and signed notification pid remain required. Matching local order/channel/provider reference and exact amount remain settlement guards; null pid never bypasses them.

Invalid signature/pid -> 401 fail; malformed or duplicate fields -> 400 fail; channel/ref/amount mismatch -> fail without fulfilment; persistence failure -> 500 fail for retry. Unknown local order -> 404 fail without fulfilment; absent/empty/legacy param does not block trusted local payments. Only TRADE_SUCCESS or numeric query status=1 enters the common settlement boundary. Fractional cents are rejected, trailing third decimal zero is accepted. Creation timeout, malformed success or failed reference persistence stays recoverable; no blind create retry. QR/scheme-only responses do not expose checkout. GET return parameters never grant benefits.

### Good/Base/Bad Cases

Good: early callback binds reference using CAS, then existing atomic complete RPC grants once. Base: status=0 remains recoverable; expired paid orders reopen. Bad: old MA IDs never query TTZF; mismatched trade references cannot overwrite the first binding. Recovery remains enabled with credentials even if PAYMENT_ENABLED disables new purchases. Worker limits: 30 candidates, concurrency 3, 25-second dispatch deadline, 5-second query; next_reconcile_at rotates before query, seven-day automatic window, later explicit queries/callbacks still recover. Only confirmed unpaid local-deadline orders expire; no bulk expiry. Refunds alert without automatic reversal.

### Tests / Manual Acceptance

Protocol, repository, callback/settlement and bounded-worker regressions are included. See task verification.md for completed checks and user-requested stop. Engineer validates TEST credentials, HTTPS checkout, paid/unpaid GET lookup, notification retries/concurrency, missing callbacks, late payments, credits/VIP and Android/iOS handoff/return. Local mocks do not prove database or provider behavior.

### Wrong vs Correct

Wrong: infer paid from return URL, round 6.001 to 6.00, or overwrite provider_transaction_id after an early callback. Correct: validate the trusted provider fact, compare exact cents, CAS the reference, then call PaymentSettlement.settlePaidOrder. Wrong: roll back to a retired-provider binary with TTZF orders in flight. Correct: disable new purchases and retain TTZF recovery while forward-fixing.

## Payment availability probe (2026-11-10, local implementation)

Independent Railway Cron `stminiapp-payment-availability-probe` runs every 30 minutes and exits. `PAYMENT_PROBE_ENABLED=true` enables it (default off), independently of normal PAYMENT_ENABLED. Channel defaults to alipay; PAYMENT_PROBE_CHANNEL may select wxpay. No client-IP environment setting is needed: resolvePaymentProbeClientIp selects a non-internal local IPv4, falling back to 127.0.0.1 when none is available or interface inspection fails. This is a local/container address, not verified public egress; there is no external discovery request. Normal user payment client IP handling is unchanged. Preview/pr environments skip before DB initialization.

`src/scripts/payment-availability-probe.ts` composes `features/payment/availability/{probe,round,strategy}.ts`. The gateway receives one ephemeral CNY 1 request with optional AbortSignal; no local order, payment operation event, query, checkout navigation or retry. Independent session lock 731007 prevents overlap, not exactly-once per slot. Soft cancellation at 45 seconds precedes a 60-second hard deadline; failed unlock still closes the owning DB connection.

New strategies implement PaymentAvailabilityStrategy (id, timeoutMs, appliesTo, handle) under `availability/strategies/` and register in `strategies/index.ts#createPaymentAvailabilityStrategies`. One/many use the same executor: at most 8 strategies, concurrency 2, per-strategy 1-25000ms budget, independent failures; total cancellation also cancels waiting work. Default feishu-alert uses the existing Publisher/outbox with fingerprint `<environment>:payment:upstream-create-probe:<channel>`. Only that rule opts into P1/recovered delivery; persistent failures reuse one incident. Acceptance means persistence, not actual delivery.

Runtime and failure contracts: [probe spec](../../payment-availability-probe.md). Extension and rollout guide: `docs/payment-availability-probe.md`. Existing payment routes, settlement and user order persistence remain unchanged. No new schema objects or migrations. Live TEST/upstream/Feishu and production enablement/performance verification remain separate; code is not deployment evidence.

## Video spending and R2V quote (2026-11-18 local candidate)

Spending includes existing video reserve/refund ledgers. Media reads are bounded5s, parallel, preserve per-segment100 limits and fail as one history request. No wallet/ledger write, settlement or migration. Same-attempt debit/refund have distinct IDs and original amounts/times.

See `docs/video-plaza-stream.md` and `.trellis/tasks/11-18-video-spending-records/verification.md` for evidence and release boundaries.

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
