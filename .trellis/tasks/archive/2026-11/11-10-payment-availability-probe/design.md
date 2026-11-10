# 独立上游支付探测设计

状态：用户已批准实施；最终实现与验证结果见 verification.md。源码交付不代表已上线。

## 服务选择

选择独立 `stminiapp-payment-availability-probe` Railway Cron，默认 `*/30 * * * *`，单轮后退出、失败不自动重启。复用 backend 镜像和现有模块，不新建仓库。

不并入 payment-cron：它每 5 分钟负责真实订单查单补账与过期判断，主动建单测试不应占用它的执行时限。不并入 payment-alert-monitor：该常驻服务同时承担供应商余额监控和共享告警投递，新策略不应拖住这些职责。新服务只发布告警评估，原 monitor 继续投递 outbox。

## 本地源码证据与复用调研（2026-11-10）

- `routes/payment.ts`、`RechargeUseCase.ts`：用户入口需要 Telegram 鉴权，按 plan_id 定价且写本地订单。不复用该 HTTP 入口，不加公开 1 元套餐或 amount 参数。
- `EpayPaymentGateway.ts#createPayment`：当前 TTZF 建单，7 秒超时、只发一次，校验业务 code、trade_no、HTTPS payurl。复用它，避免第二套签名/传输逻辑。
- 复用 `epay-protocol.ts#createEpayOrderId` 生成临时 EP 单号，复用 `epay-http.ts` 超时、响应体上限、禁重定向及脱敏错误类别。
- 不使用 `MiniappPaymentOrderRepository`、`PaymentOperationEvents` 或 `PaymentReconciliation`；避免污染用户订单与告警统计、占用真实订单对账容量。
- 复用现有 `AlertEvaluation` shared 契约、`AlertPublisher`、Prisma 事故/outbox、`AlertDeliveryWorker`、`FeishuAlertSink`，不直接新增飞书 HTTP 客户端。
- `delivery-worker.ts` 当前会抑制支付域 P1 及恢复；必须针对新规则精确放行，不能为了绕过滤改成 P0，也不能仅 publish 就宣称飞书已送达。
- 复用 `postgres-advisory-lease.ts`，用独立 lock key 防重叠；不与 monitor 共用锁，不用 Prisma 池连接持有 session lock。
- 已检索 routes/features/repositories/contracts/helpers；无组件/hooks 需求，无新增数据库函数或表。
- 文档差异：支付模块含 Vexutopia 历史章节，以最新 TTZF 章节与源码为准。当前 `.railway/railway.ts` 有两处同名 paymentAlertMonitorEnv 声明，实施前核验这一已有问题。本地 IaC 不证明远端实际部署。

## 单轮流程

1. 校验环境、开关、单渠道、合法探测 clientIp 与网关配置。PR/preview 默认不运行；配置错误单独归因，不宣称上游不可用。
2. 非阻塞获取独立 session advisory lock，未取得跳过；DB/锁失败不建单。连接/查询沿用现有 8 秒上限，finally 关闭连接。网络调用不放在数据库事务内。
3. 临时随机 EP 单号，amount='1.00'，商品名沿用“星尘”，clientIp 为明确配置的合法服务器公网 IP。只调用一次现有 createPayment；不付款、不访问链接。
4. 只留下渠道、时间、耗时和稳定错误分类，丢弃商户单号、上游单号、URL、响应原文。超时/网络失败表示本次无法确认可用，不断言上游未建单；不重试、不查回。
5. 安全结果交给策略执行器，结束后释放资源并退出。整体 45 秒主动取消在途工作及待执行策略，60 秒硬退出兜底；策略分别有预算。不能仅 Promise.race 而不取消底层工作，网关调用仍在途时不能再发一次。

现有网关要求合法 notify/return URL，沿用本环境配置即可。不新增回调流程。因为不付款、不打开收银台，本方案不期待回调；即使意外收到通知，现有处理器因无本地订单拒绝履约，不创建订单或权益。若真实上游未付款也主动通知而产生噪声，再根据实测协议处理。

## 单策略与多策略

- 内部接口只有稳定 id、适用条件及有时限的 handle(result, context)，不新增公开 HTTP API。
- 配置为策略列表，默认 `[feishu-alert]`；一个元素就是单策略，多个元素就是多策略。入口注册有限策略，拒绝未知或重复 id，不加载任意脚本。
- 执行器以有界并发 allSettled 收集结果；单策略异常/超时不阻断其他策略、不重发建单。多策略不依赖顺序；未来冲突动作必须另行定义仲裁。
- 首期只实现飞书策略：异常发布 firing、成功发布 healthy；具体发送仍由原有 outbox worker 处理。其他策略可只订阅异常。
- 后续自动关支付/切换渠道等策略须另行评审幂等、授权、恢复及并发，不提前实现通用队列、插件框架或策略状态表。
- 首期由组合入口配置策略列表，不加运营页面。部署参数集中于 platform/config.ts；未来若需动态运营配置，走 runtime-config.ts、admin-client schema/menu 与现有 CLI 发布流程。

## 告警语义

- 首次失败 P1“支付服务不可用：上游建单探测失败”，正文明确环境和所测渠道；只证明该渠道该次建单失败，不代表全支付链路。网络超时用 suspected，429 单独标明受限，配置错误单独作为监控配置问题。
- fingerprint 为环境/payment/专用规则组/渠道，不包含每轮时间、单号或 UUID。复用现有事故事务与 outbox；同级连续失败只更新事故，不每半小时刷屏。
- 下一次成功恢复该事故，精确放行新规则的 P1 与恢复通知；旧支付/体验/模型告警保持原行为。跳过、配置失败、进程中止不发布 healthy。
- 同一次 publish 的 evaluation_id 固定；Publisher accepted 只表示已持久化。验证通知开关、webhook 和原 monitor 均有效；共享 outbox 积压时可能延迟。
- 不保存探测订单，但仍保存现有告警事故和投递数据。DB 不可用时不能保证飞书通知，使用安全日志/现有后台观测报告监控失败，不新增旁路发送器。
- 无自动关停真实支付、无每半小时提醒状态机。理想调度下发现延迟约 0–30 分钟加执行与投递耗时，服务停机或调度延误更长。

## 性能、可靠性与取舍

- 单渠道每天计划 48 次建单（频率计算，非实测），无实际付款；上游仍会保存未付订单，TEST 需核验 1 元受理、未付单生命周期、风控及配额。
- 独立进程与小连接预算，不占 API 事件循环、用户支付请求或补账并发槽；仍共享上游商户配额与 DB，不能声称绝对零影响。出现真实用户延迟/429 上升立即停用探测。
- advisory lock 只防重叠，不保证同一半小时 exactly-once。单实例、禁失败自动重启、无补跑；人工/部署重复启动可能多建一笔，接受无实际扣款的低频副作用。若要求严格每窗一次须另评审最小调度状态，不暗中保存探测订单。
- 无本地订单写入，故不需要钱包事务、退款、补单或订单清理。请求未知就丢弃；告警失败不能重发建单。
- 不新增表/视图/函数或 migration；既有告警事实权威仍是 app_core 事故/outbox，探测不建立第二状态源。

## 发布与恢复

先部署新告警规则的兼容投递 consumer，再部署默认禁用的 Cron。TEST 确认凭据、金额、失败/恢复通知、无本地订单写入后，再单独启用 production；PR 不复制真实探测。

IaC 显式引用 TTZF、notify/return、DB/DIRECT_URL 及后台观测所需配置；当前 paymentCronEnv 没有 PAYMENT_NOTIFY_URL，不能直接照搬就假设可建单。探测服务不需要飞书 webhook，发送仍归旧 worker。

无迁移、无旧订单处理。故障时停用独立 Cron，不影响原支付、对账与告警投递；上游未付单由原生命周期收口，不伪造取消。停止条件：触发商户风控、用户支付延迟/429 上升、重复调度、告警过滤或积压异常。
