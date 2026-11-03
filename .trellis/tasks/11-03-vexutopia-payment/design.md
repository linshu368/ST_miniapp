# Design：支付供应商替换为 Vexutopia

## 1. 复用调研

| 检索对象                                                                                                            | 结论       | 理由                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/payment/usecases/PaymentSettlement.ts`（`settlePaidOrder` / `reconcileWithGateway` / `parseAmountCents`） | 复用       | 已是所有入账路径的唯一出口：订单锁、金额比对、expired 重开、通知、邀请奖励、事件都在这里；只把网关类型从 `ZqPaymentGateway` 换成新的接口类型，查单入参从订单 id 改为订单行。 |
| `billing.complete_payment_order` RPC                                                                                | 复用，不改 | `provider_transaction_id = COALESCE(p, 原值)`，建单时先写交易号、入账时再传同一个值不冲突；`settled_by` 只接受 webhook/return/query/cron，新链路只产生 webhook/query/cron。  |
| `billing.payment_orders.provider_transaction_id`                                                                    | 复用       | 建单成功后写入 Vexutopia `tx_…`，查单用它；无需迁移。                                                                                                                        |
| `RechargeUseCase.createOrder`                                                                                       | 扩展       | 增加“写交易号”一步和 ¥1–1,000 校验，其他编排不变。                                                                                                                           |
| `FastPaymentReconciliation` / `ExpirePaymentOrders` / Railway 两个 cron                                             | 复用       | 只调整 `queryOrder` 入参；无交易号的订单在查单前跳过并记为 skipped。                                                                                                         |
| `PaymentOperationEvents` + `PaymentAlertRules` + `PaymentAlertMonitor`                                              | 复用       | 规则与供应商无关；新代码按既有 `event_kind`/`outcome` 写事件，错误分类细化。Webhook 签名失败沿用规则识别的 `signature_invalid`。                                             |
| `routes/alerts.ts` 的封装作用域原始 body 解析                                                                       | 复用模式   | Webhook 验签需要原始 body；在单独注册的子插件里加 `application/json` buffer 解析，不影响其他路由。                                                                           |
| 前端 `open-created-payment.ts` / `openPaymentUrl` / `isAllowedPaymentOpenUrl` / 订单轮询页                          | 复用，不改 | 只要求 `pay_url` 是 https；Vexutopia `checkout_url` 满足。                                                                                                                   |
| `payment_channels` 运行时配置（admin 可开关支付宝/微信）                                                            | 复用       | 微信在供应商侧不可用时会被按支付宝创建，运营可在后台关闭微信入口。                                                                                                           |
| shared `PaymentType`、`CreatePaymentOrderData.pay_url`、`PaymentSettlementSource`                                   | 复用，不改 | 契约不含供应商细节，无需改 shared。                                                                                                                                          |
| `ZqPaymentGateway`、RSA 签名、表单解析器、`/webhook/zqpay`、`diagnose-zqpay-query.ts`                               | 删除       | 老供应商整体废弃，不保留兼容分支。                                                                                                                                           |

## 2. 方案

### 2.1 网关适配器 `infrastructure/payment/VexutopiaPaymentGateway.ts`

对外三个能力，保持与旧网关同形的返回结构，调用方改动最小：

- `createPayment({ orderId, amount, paymentType, description, userId })`
  - `POST {base}/payments`，头：`X-API-Key`、`Content-Type`/`Accept: application/json`、`User-Agent: MIJINGAI-Backend/1.0`、`Idempotency-Key: order-<orderId>`。
  - body：`amount`（元，两位小数字符串）、`currency: "CNY"`、`payment_method: ALIPAY|WXPAY`、`country: "CN"`、`locale: "zh-CN"`、`return_url`（`PAYMENT_RETURN_URL?order_id=<id>`）、`description`（商品名）、`customer_id`（本地 user id）、`metadata: { order_id, env }`。
  - 返回 `{ success, paymentUrl, providerTransactionId }`；`checkout_url` 必须是 https、`id` 必须形如 `tx_`。
- `queryOrder({ id, provider_transaction_id })`
  - 无交易号直接返回 `{ success: false, errorClass: 'missing_provider_ref' }`（调用方在此之前已跳过，这里只是防御）。
  - `GET {base}/payments/:tx`；`completed` → `paid: true`，并带回 `amount`、`currency`；`pending/failed/expired/cancelled` → `paid: false`；`refunded/partially_refunded` → `paid: false` 且记 warn。
  - 核对返回的 `metadata.order_id` 等于本地订单 id，不等视为 `response_invalid`。
- `verifyWebhook(rawBody, signatureHeader, now)` → 解析 `t`、`v1`，`|now - t| ≤ 300s`，HMAC-SHA256 hex(`{t}.{raw}`) 常量时间比较。

错误分类（写入 `errorClass`，进入操作事件）：

| Vexutopia 结果                                              | errorClass             | 可重试                            |
| ----------------------------------------------------------- | ---------------------- | --------------------------------- |
| 401/403 key 无效、吊销、过期、权限不足、账户停用            | `configuration`        | 否                                |
| 422 校验、`CHINA_PAY_*`、`NO_PROVIDER_AVAILABLE` 等其他 4xx | `provider_rejected`    | 否                                |
| 503 `PAYMENT_METHOD_MAINTENANCE`                            | `method_maintenance`   | 否（用户可换渠道）                |
| 429 `RATE_LIMITED`                                          | `rate_limited`         | 是，遵守 `Retry-After`，上限 2 秒 |
| 503 `PROVIDER_UPSTREAM_UNAVAILABLE`、502、500               | `provider_unavailable` | 仅 503 上游不可用可重试           |
| 超时                                                        | `timeout`              | 是                                |
| 网络错误                                                    | `network`              | 是                                |
| 响应缺字段、URL 非 https、metadata 不符                     | `response_invalid`     | 否                                |

### 2.2 下单 `RechargeUseCase.createOrder`

1. 读取权威商品 → 校验 `amount_cents` 在 100–100000 之间，否则直接抛错（不建本地单）。
2. 建本地订单（pending，15 分钟过期，不变）。
3. 调 `createPayment`；失败 → `markFailed` + 事件 + 抛错（不变）。
4. 成功 → `attachProviderTransaction(orderId, tx)`（只在 `provider_transaction_id IS NULL AND status = 'pending'` 时更新）。写入失败 → 标记 failed 并抛错，不把收银台地址交给用户。原因：没有交易号的订单无法查单，只能依赖 Webhook；宁可让用户重下一单，也不制造只能靠单一路径确认的订单。供应商侧那笔未支付交易 1 小时后自行过期。
5. 返回 `pay_url = checkout_url`。

### 2.3 Webhook `POST /api/payment/webhook/vexutopia`

在独立子插件里注册，`application/json` 解析为 Buffer。处理顺序：

1. 未配置 `VEXUTOPIA_WEBHOOK_SECRET` 或验签失败/超时 → 401，事件 `failed / signature_invalid`。
2. JSON 解析失败 → 400。
3. `metadata.env` 不等于本环境标签 → 200，事件 `skipped / foreign_environment`（不计入失败，不触发告警）。
4. 只处理 `payment.completed`；`payment.refunded` → 200，记 warn + 事件 `failed / refunded|chargeback`（第一版人工处理）；其他事件 → 200 忽略。
5. 取 `metadata.order_id`（格式校验）→ 订单不存在 → 200 + warn；订单已有交易号且与 `payment_id` 不同 → 200 + `provider_ref_mismatch`。
6. `currency !== 'CNY'` → 按金额不符处理；否则 `settlePaidOrder(paidAmount = amount, providerTransactionId = payment_id, source = 'webhook')`。
7. `completed` → 200；`amount_mismatch` → 200（重投也修不好，靠事件和告警）；`failed`（数据库等瞬时错误）→ 500，让供应商重投。

入账是一次数据库 RPC，在响应前同步完成，这样失败时才能用 500 换来重投。

### 2.4 回跳 `GET /api/payment/return?order_id=`

参数不签名，不作为入账依据。校验 id 格式后：若订单存在且仍 pending，执行一次 `reconcileWithGateway(source='query')`（受现有 5 秒节流），失败不阻塞；然后按现有逻辑跳回 `t.me/<bot>/<app>?startapp=payment_return_<id>`。

### 2.5 多环境隔离

- 环境标签 `paymentEnvironmentTag = RAILWAY_ENVIRONMENT_NAME || NODE_ENV`，建单写进 `metadata.env`，Webhook 比对。
- 生产和 dev/TEST 各注册一个 Webhook 端点、各自持有 secret。
- PR 预览环境不注册端点、不配 secret：只靠前端轮询查单和 cron 入账（查单是权威来源）。`railway-pr-env.yml` 删除 `PAYMENT_NOTIFY_URL` 注入，保留 `PAYMENT_RETURN_URL`。
- 新增脚本 `payment:webhooks`：`list` / `register <url>` / `delete <id>`，调用 `/v1/webhooks`。`register` 只把 secret 打印到当前终端一次，不经过 pino、不落盘，提示操作者立即写入 Railway。

### 2.6 配置

| 变量                                                                                                                               | 说明                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `PAYMENT_ENABLED`                                                                                                                  | 保留                                         |
| `PAYMENT_RETURN_URL`                                                                                                               | 保留，`https://<backend>/api/payment/return` |
| `VEXUTOPIA_API_KEY`                                                                                                                | 新增，secret                                 |
| `VEXUTOPIA_BASE_URL`                                                                                                               | 新增，默认 `https://vexutopia.com/api/v1`    |
| `VEXUTOPIA_WEBHOOK_SECRET`                                                                                                         | 新增，secret；为空时 Webhook 一律 401        |
| `PAYMENT_BASE_URL` / `PAYMENT_MERCHANT_ID` / `PAYMENT_MERCHANT_PRIVATE_KEY` / `PAYMENT_PLATFORM_PUBLIC_KEY` / `PAYMENT_NOTIFY_URL` | 删除                                         |

### 2.7 对账与告警改用平台直接信号（2026-11-03 用户确认）

老供应商查不到渠道和订单的真实情况，原监控只能靠“用户打开过收银台却没付成”去推测故障；Vexutopia 直接给出订单状态和渠道维护信号，所以整体替换：

已实测（用户 2026-11-03 的 ¥1 支付宝测试单）：`POST /v1/payments/lookup`，body `{"payment_ids": [...]}`（≤100），返回 `results[]`：`id`、`found`、`status`、`amount`（如 `"1"`）、`currency`、`payment_method`、`processor`（`china_pay`）、`failure_reason`、`metadata`、`completed_at`。根交易号查回 `completed`，设计第 6.1 项的子交易风险排除。changelog 也写明 2026-05-09 起 Webhook 的 `id`/`payment_id`/`order_id` 都等于根会话 id。测试单 metadata 里的 `channel` 键没有回显，说明部分键名被平台保留，因此 metadata 改用 `mijing_order_id` / `mijing_env`。

**对账**（替换 `FastPaymentReconciliation` 的逐单领取/租约/退避和 `ExpirePaymentOrders` 的逐单查单）：

- 一个纯用例 `PaymentReconciliation.runTick({ trigger })`：取最近 2 小时内创建、未履约、有交易号、状态为 pending 或 expired 的订单（≤300），按 100 个一批调 lookup。
  - `completed` → `settlePaidOrder(source='cron')`。
  - 平台终态未付（`failed`/`expired`/`cancelled`/`refunded`）且本地仍 pending → 本地置 expired（可被迟到的确认重开），记一次事件 `unpaid / provider_<status>`。
  - `pending` → 不记事件（避免每 30 秒刷事件表）。
  - 整批 lookup 失败 → 一条 `failed` 事件，本轮跳过后续步骤。
- 30 秒常驻 Worker（`reconcile-payment-orders.ts`）和 5 分钟 Cron（`expire-payment-orders.ts`）都调用它；Cron 之后再执行现有 `expire_payment_orders` RPC。若本轮 lookup 整体失败则跳过判过期，替代原来按逐单失败率判断的逻辑。
- 三个 Railway 服务（对账 Worker、过期 Cron、告警监控）的名称和启动命令都不变，不需要改 Railway 配置。`payment_orders` 上 `next_reconcile_at`/`reconcile_attempts`/`reconcile_locked_until` 不再使用，按约定不写迁移删除。
- 前端轮询订单详情仍用单笔 `GET /payments/:id`（现有 5 秒节流）。

**告警**（重写 `PaymentAlertRules`，规则版本 v3，只读 `payment_operation_events`，不再扫订单和收银台确认）：

| 规则                         | 级别 | 触发                                                                                                  | 飞书 |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------- | ---- |
| `p0-provider-create-failing` | P0   | 10 分钟内建单失败 ≥3 且最近 3 次全失败；摘要列出错误分类（渠道维护/供应商不可用/配置错误…）           | 是   |
| `p0-paid-not-fulfilled`      | P0   | 10 分钟内出现入账失败事件（平台已确认付款，本地履约失败/金额不符/单号不符），且同订单之后没有入账成功 | 是   |
| `p1-refund`                  | P1   | 60 分钟内收到 `payment.refunded`（退款或拒付）                                                        | 是   |
| `p1-provider-query-failing`  | P1   | 10 分钟内查单/批量查单失败 ≥3 且失败占比 > 80%                                                        | 否   |
| `p1-webhook-rejected`        | P1   | 10 分钟内 Webhook 验签失败或未配置 secret ≥3                                                          | 否   |

**删除**：`CheckoutConfirmation` 用例、`POST /api/payment/orders/:id/checkout-confirmations` 路由、shared 里对应 schema/类型、前端三页的确认上报和 `open-storage` 里的确认队列（“继续付款”所需的收银台地址缓存保留）；`PaymentAlertAggregation` 及两条推测性 P0（同用户 5 分钟 2 单未付、连续 4 单未付）和已注释停用的旧规则。`record_checkout_confirmation` RPC 与 `checkout_*` 列留在库里不再调用，不写迁移。

**保留**：通用告警发布/投递（`AlertPublisher`、飞书 sink、`alert_incidents`，Sentry 告警也在用）、`payment_operation_events`、入账路径日报脚本 `payment:callback-report`、PostHog 支付漏斗事件。

### 2.8 实测与文档不一致之处（2026-11-03，用开发 key 建未支付的 ¥1 单验证）

- 同一 `Idempotency-Key` + 完全相同 body 重放返回 `409 IDEMPOTENCY_KEY_REUSED`（ASCII/中文 body 都一样），不是文档说的返回原结果。幂等键仍能保证一单最多一笔平台交易；首次超时但实际已建单时，重试失败、订单标 failed，用户重新下单。
- China Pay 收银台 `expires_at` 为创建后 30 分钟（文档写 1 小时）。本地 15 分钟过期 + 2 小时对账窗口足以覆盖晚付。
- `GET /payments/:id` 与 `POST /payments/lookup` 都原样回显 `mijing_order_id` / `mijing_env`。

## 3. 可靠性设计

| 项     | 设计                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 超时   | 建单每次 7 秒；查单 5 秒；Webhook 管理脚本 10 秒。                                                                                                                                                                 |
| 重试   | 只有建单在 `timeout`/`network`/`rate_limited`/上游 503 时重试 1 次，间隔 500 ms（或 `Retry-After`，上限 2 秒），同一幂等键；最坏总耗时约 16 秒。查单不重试（调用方本身就会周期性再查）。Webhook 重投由供应商负责。 |
| 幂等   | 建单：`Idempotency-Key = order-<本地订单id>`，同单重试拿回同一交易；入账：`complete_payment_order` 行锁 + `fulfillment_applied`；重复 Webhook 走同一出口。                                                         |
| 并发   | Webhook、轮询查单、两个 cron 可能同时确认，均收敛到行锁 RPC；`attachProviderTransaction` 用条件更新避免覆盖。                                                                                                      |
| 事务   | 订单状态与钱包/VIP 履约仍在 `complete_payment_order` 单事务内。                                                                                                                                                    |
| 降级   | Webhook 缺失 → 查单兜底；查单失败 → 下一轮 cron；渠道维护 → 建单返回明确错误，前端提示换渠道。                                                                                                                     |
| 补偿   | 已付款但本地已过期 → `settlePaidOrder` 重开再履约（现有）；付款晚于本地 15 分钟有效期、早于收银台 1 小时过期，靠 Webhook 和判过期对账任务（24 小时窗口）补账。                                                     |
| 限流   | 供应商每 key 300 次/分钟；现有查单 5 秒节流 + 快速对账退避（2 分钟、5 分钟）远低于上限。                                                                                                                           |
| 容量   | 月流水几千到几万元，订单量为每天几十到几百笔，无容量问题。                                                                                                                                                         |
| 可观测 | 每次建单/查单/回调写操作事件和结构化日志（订单 id、交易号、错误分类、耗时），不记 key、secret、签名、收银台完整 URL。现有 P0/P1 告警规则直接覆盖“建单阻断”“已付款未履约”“Webhook 异常/退化”“查单整体失效”。        |

## 4. 最小充分方案

- 新文件：网关适配器（+测试）、Webhook 管理脚本。其余都是改现有文件。
- 不新增表、迁移、shared 契约、前端页面、状态源或公开 API（Webhook 路由替换旧路由）。
- 拒绝的过度设计：多供应商抽象层/路由切换（只有一家供应商）；自建渠道健康探针（会产生真实交易，且状态页无接口）；退款自动扣回；本地 Webhook 事件表（按交易号和订单幂等已足够）。

## 5. 演进与恢复

- 发布顺序：
  1. 用户在 Vexutopia 新建一把 Live key（交接文档里的那把作废），写入 Railway development 环境 `VEXUTOPIA_API_KEY`。
  2. 部署到 dev/TEST 后，用 `payment:webhooks register` 注册 TEST 端点，secret 写入 `VEXUTOPIA_WEBHOOK_SECRET`。
  3. TEST 按验收清单真实支付（支付宝、微信 × 星尘、VIP；关 Webhook 走查单；重复投递用 `resend-webhook`）。
  4. 生产：基于最新 main 的发布分支 → Railway production 写入 key → 部署 → 注册生产端点和 secret → `PAYMENT_ENABLED=true` → 生产小额真实支付冒烟。
- 无迁移，回滚只回滚代码；老供应商已不可用，回滚到旧版本等于停用支付，所以出问题优先 `PAYMENT_ENABLED=false` 止血再 forward-fix。
- 停止条件：TEST 任一验收项失败、生产冒烟入账失败或重复入账、出现 `provider_ref_mismatch`/`amount_mismatch`。

## 6. 风险与待 TEST 确认项

1. ~~**China Pay 是否拆子交易**~~：已排除（见 2.7 实测）。TEST 仍需看一次 Webhook 载荷确认 `payment_id` 与 metadata 回显。
2. **按单 `webhook_url` 的签名 secret 未说明**：所以不用它，改用注册端点。
3. **微信降级为支付宝**：用户选微信却看到支付宝页面。由运营在后台关闭微信入口处理，不在代码里猜测。
4. **key 需要 `webhooks:write` 权限**才能注册端点；如果新 key 没有，就到控制台补权限。
