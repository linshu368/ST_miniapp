# 支付上游可用性探测与策略扩展

## 用途与运行方式

独立 Railway 服务 `stminiapp-payment-availability-probe` 默认按 `*/30 * * * *` 运行，每轮向 TTZF 创建一笔 **1.00 元待支付订单**，随后丢弃响应中的订单号和支付链接。它只验证所选渠道的上游建单能力，不付款、不打开收银台、不查单，不写本地支付订单、支付操作事件或账务。

任务与 API、`payment-cron` 补账/过期任务、`payment-alert-monitor` 告警投递进程独立，复用 backend 镜像。单轮入口是 `packages/backend/src/scripts/payment-availability-probe.ts`，包命令是 `pnpm --filter @miniapp/backend payment:probe`。该命令在开关打开时会真实请求上游，验收前应确认目标环境。

当前代码和 IaC 定义不代表远端已部署或已启用；没有新增数据库 migration。

## 环境变量开关

以下变量只需配置在**独立探测服务**，由 `platform/config.ts` 统一读取，不通过运营配置/CLI 控制：

- `PAYMENT_PROBE_ENABLED`：只有精确的 `true` 开启；缺失或其他值跳过，默认关闭。与用户支付 `PAYMENT_ENABLED` 相互独立。
- `PAYMENT_PROBE_CHANNEL`：`alipay` 或 `wxpay`，默认 `alipay`；每轮只测所选渠道。

探测请求的 `clientip` 自动从本机网卡选择非回环 IPv4；没有匹配或读取网卡失败时使用 `127.0.0.1`。无需配置 `PAYMENT_PROBE_CLIENT_IP`，也不请求外部 IP 查询服务。该值是服务进程的本地/容器地址，不代表 NAT 后的公网出口；正常用户支付继续使用原来的真实客户端 IP。

同时需要本环境 `TTZF_APP_ID`、`TTZF_APP_KEY`、`TTZF_BASE_URL`、`PAYMENT_NOTIFY_URL`、`PAYMENT_RETURN_URL`，以及现有数据库环境选择与 `DATABASE_URL`/`DIRECT_URL` 配置。凭据由部署平台注入，不写文档或源码。IaC 为开关/渠道使用 `preserve()`，保留平台值，不在每次 apply 时重置开关。旧 IP 环境变量不再读取，可在后续部署配置维护时移除。

Railway `pr-*`/preview 环境及 `SENTRY_ENVIRONMENT=preview` 会被运行时保护跳过；PR 环境工作流还会删除复制来的探测服务，避免每个 PR 使用同一 TEST 商户建单。关闭开关后下一次运行跳过；要立即停止已在途的一轮，终止该服务进程。

## 源码入口

- `packages/backend/src/features/payment/availability/probe.ts`：校验开关/渠道，自动选择本机 IP，只调用一次现有 `EpayPaymentGateway.createPayment`，输出脱敏观察结果。
- `packages/backend/src/features/payment/availability/round.ts`：一轮任务编排，独立租约、探测与策略执行。
- `packages/backend/src/features/payment/availability/strategy.ts`：策略接口、校验和有界执行器。
- **`packages/backend/src/features/payment/availability/strategies/index.ts`：新增策略的注册/组合入口。**
- `packages/backend/src/features/payment/availability/strategies/feishu-alert.ts`：默认策略，将结果转成现有 `AlertEvaluation` 并交给 `AlertPublisher`。
- `packages/backend/src/features/alerting/delivery-worker.ts`：共享飞书 outbox 投递及新探测规则的精确放行。

## 新增一个策略

1. 在 `availability/strategies/` 下创建实现文件，实现 `PaymentAvailabilityStrategy`。内部观察结果只有 `kind`、`channel`、`startedAt`、`observedAt`、`durationMs`、可选 `errorClass`，不包含原始上游响应或订单身份。
2. `id` 使用唯一的小写标识；`timeoutMs` 为 1–25000 毫秒整数。`appliesTo` 决定是否处理成功或异常，`handle` 接收取消信号。
3. 在 `strategies/index.ts#createPaymentAvailabilityStrategies` 返回的数组中加入策略。单元素即单策略，多元素即多策略；首期默认只有 `feishu-alert`，不需要另加模式开关。
4. 外部请求必须传递 `signal`，并配置不超过策略预算的原生超时。策略不可脱离执行器启动后台副作用；当前调用失败不能重新发起支付探测。会更改业务状态的策略另行评估幂等、并发、权限与恢复。
5. 补充该策略失败/超时与组合回归；更新本文和模块 spec，说明失败结果、部署变量及人工验证。

接口位于 `strategy.ts`：

```ts
interface PaymentAvailabilityStrategy {
  id: string;
  timeoutMs: number;
  appliesTo(observation: PaymentAvailabilityObservation): boolean;
  handle(observation: PaymentAvailabilityObservation, signal: AbortSignal): Promise<void>;
}
```

只处理异常的策略使用 `appliesTo: observation => observation.kind === 'unavailable'`。飞书策略同时处理成功结果，因为成功需要关闭已有事故。执行器最多允许 8 个策略，并发最多 2；重复 id、非法超时或空列表在建单前被拒绝。在本轮总预算内，单策略失败/超时不会阻止其他策略；到 45 秒会取消在途工作，尚未开始的策略记为 cancelled，预留时间清理连接，60 秒仍未结束则强制退出。策略间不保证副作用顺序，也没有跨轮自动重放。新增多个慢策略时必须评估总预算，不能把每策略 25 秒当成每个策略都保证可用的时间。需要先后依赖或相互冲突的处理时，应在该业务策略内部明确协调，不依赖数组排序。

## 飞书与故障语义

新规则指纹为 `<environment>:payment:upstream-create-probe:<channel>`，失败 P1，下一次成功恢复。连续同等级失败复用既有事故，不每半小时刷屏；网络/超时标为 suspected，不推断上游一定未建单。无执行、配置错误或取消均不发布 healthy。

`AlertPublisher` 只负责原子保存事故/outbox；真正发送由现有 `payment-alert-monitor` 完成。`accepted` 表示已持久化，不是已送达。需确认既有 `alerting.notifications_enabled` 已开启、monitor 在运行且配置了飞书 webhook。探测服务本身不需要 webhook。新规则的 P1/恢复被精确放行，原支付告警抑制规则保持原语义。

建单失败、监控配置错误、策略持久化失败、通知关闭、飞书投递失败必须区分。数据库/租约不可用时不发建单，日志报告本轮监控失败；共享 outbox 不可用时不保证飞书送达。告警队列积压会增加送达延迟。

## 隔离、容量与恢复

- 建单沿用 7 秒超时、单次请求、不重试；SIGTERM 或本轮达到 45 秒时取消在途调用/策略，整体硬期限 60 秒。
- 非阻塞独立 advisory lock `731007` 防止重叠，结束关闭连接；不占用 monitor 的锁，不持有跨网络数据库事务。禁用/preview 在初始化数据库之前跳过。
- 不保存调度时间槽，锁只防重叠，不承诺同一时间窗 exactly-once。部署或人工重复启动可能多创建一笔待付订单；禁失败自动重启，不补跑历史。
- 每渠道每天计划 48 次建单，无实际付款；上游仍保存待付单，需要真实 TEST 验证 1 元受理、未付款生命周期及商户风控。共享商户配额/DB 仍可能受影响，不能用独立进程推断零影响。
- 无订单清理/退款/补偿流程。意外通知沿用现有“无本地订单则拒绝履约”的边界，不创建权益。出现上游未付款通知噪声时先根据真实协议调查。

## 发布、验收与停止

先部署共享投递 worker 对新指纹的兼容支持，再部署默认关闭的独立 Cron；TEST 验证通过后单独启用 production。停用时设置 `PAYMENT_PROBE_ENABLED=false`，保留正常支付和共享告警投递。发现用户建单 P95/429 上升、商户风控、重复调度或告警积压时停用探测并调查。

本地验证：

```sh
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm lint:complexity
pnpm lint:imports
```

用既有 mock 回归正常→失败→持续失败→恢复、多策略 throw/超时、关闭/preview、取消、无订单写入及旧告警过滤行为。TEST 人工受控运行核实真实建单与飞书送达，不打开支付链接；不经 Supabase MCP 读取业务行。启用前后各观察 24 小时 Android/iOS 充值页和用户建单 API P95、连接池/上游限流，低样本延长；当前未采集真实基线，不能宣称性能已达标。
