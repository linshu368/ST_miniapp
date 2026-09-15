# 用户行为回放：现有系统调研

调研时间：2026-09-15  
证据范围：当前 checkout 的源码、`.trellis/spec/` 与 PostHog 公开文档；未访问 PostHog、Supabase 或支付供应商的生产/测试数据。

## 已存在的可复用链路

### 聊天与回放生命周期

- `packages/frontend/src/app/layout.tsx` 在所有前端路由外层挂载 `Providers`；`packages/frontend/src/app/providers.tsx` 在 Telegram 就绪后解析用户、设置 Sentry 用户并加载现有 Sentry Replay。
- `packages/frontend/src/app/chat/[characterId]/page.tsx` 是不带底部导航的聊天路由；`packages/frontend/src/hooks/use-chat-session.ts` 创建/恢复 URL 中的 `session` 会话。
- `packages/frontend/src/hooks/use-conversation-turn.ts` 集中处理发送、重生成、15 秒卡顿提示、SSE 成功/失败分流和余额不足跳转。
- `packages/frontend/src/lib/api/conversation-stream.ts` 是唯一 SSE parser；本任务应在它的调用结果处记录业务事件，不重写 parser 或在组件中新增并行 `fetch`。

### 余额不足、充值与支付

- `packages/frontend/src/lib/recharge-redirect.ts` 是聊天 SSE、语音和模型切换共同使用的余额不足入口；应作为“付费墙触发/跳转充值”事件的单一前端挂点。
- `packages/frontend/src/app/(main)/profile/recharge/page.tsx` 展示余额不足提示、邀请入口、套餐与可选 VPN 提示。它创建订单后先调用 Telegram `openLink`，再进入订单等待页。
- `packages/frontend/src/app/(main)/profile/recharge/[orderId]/page.tsx` 在订单 `pending` 时轮询服务端状态。`packages/frontend/src/app/providers.tsx` 将 Telegram payment-return 深链恢复到该页。
- `packages/backend/src/routes/payment.ts` 创建订单、查询/对账订单和处理 return/webhook；`packages/backend/src/features/payment/usecases/PaymentSettlement.ts` 是四条结算入口的唯一收口。前端回放不可替代这些服务端事实。

### 既有 telemetry 与敏感边界

- 仓库无 PostHog 或 rrweb 依赖/初始化。现有客户端回放来自 `packages/frontend/src/instrumentation-client.ts` 和延迟加载的 `packages/frontend/src/lib/sentry/client.ts`。
- 当前 Sentry Replay 设置 `maskAllText: false` 和 `blockAllMedia: false`，但 `.trellis/spec/frontend/app/api-dataflow-and-state.md` 禁止将消息正文、支付参数和完整 initData 放进 replay；现状与新需求均需单独治理，不能将现有设置视为可批准策略。
- `packages/shared/src/telemetry/sanitize.ts` 按敏感键清理 telemetry，但不清理任意聊天正文；不得把它当作 PostHog 回放 DOM/事件属性的充分保护。
- `packages/frontend/src/lib/telegram/launch-url.ts` 会清除 URL 中的 Telegram 初始化参数。支付等待页目前会把 `pay_url` 置于 query；该 URL 必须从录制和事件属性中排除，并在实现阶段评估是否可安全地移至短生命周期内存/session storage。

## 不复用或不应新建的方案

- 不复用 Sentry Replay 作为需求交付：目标是 PostHog 的会话检索与产品事件关联。需求方已接受与现有 Sentry Replay 双录制；本期不关闭、不降采样、不替换 Sentry Replay。
- 不向 `miniapp_analytics` 写运行时数据：该 schema 是只读分析视图，架构明令禁止把它变为运行时依赖。
- 不直接从前端读取数据库行补用户标签：前端仅消费 shared API DTO；如当前接口无法安全提供所需标签，应使用新增的最小共享契约和受鉴权 API，或用服务端支付事件补充。
- 不新增支付结算出口、SDK 自定义播放器、通用事件框架、队列或数据库迁移。PostHog 原生回放/检索和既有订单事实已足够满足当前目标。

## 真实故障与可观测性模型

- PostHog 初始化、网络上报、WebView 存储或录制权限可能失败：SDK 必须惰性加载、有限失败记录并降级，不能阻断 Telegram 初始化、聊天、充值或订单回跳。
- SSE 的 `delta` 频繁：禁止为每个 chunk 发送分析事件；只记录 turn 生命周期节点，画面节奏由 replay 本身呈现。
- 外部收银台不可被 MiniApp 录制：只能在打开前、恢复后和服务端订单终态打关联事件。用户离开未返回时只能报告最后已观测动作，不能判断外部付款是否失败。
- 订单轮询、return、webhook、query 和 cron 可能以不同顺序到达：终态和 `settled_by` 仅从服务端订单/结算逻辑获取；事件必须携带 order ID、事件来源与时间，且对重复上报可安全去重。
- 整段聊天文本进入第三方回放会包含用户自行输入的个人信息或模型回显的敏感信息：这是高风险数据处理，必须以审批、项目区域、访问最小化、审计和套餐上限内的到期删除作为发布前置条件，而非技术上默认接受。当前 Free 套餐最长 30 天。

## 待实现前需核验的第三方事实

- 选定 PostHog 项目/区域、套餐对 Session Replay 保留的实际能力（**当前 Free 最长 30 天**），以及是否支持指定的到期删除与访问审计。
- 外部支付供应商或 Telegram 是否有允许且合规的回调/事件关联机制；本任务不以录制外部收银台为前提。

## PostHog 公开文档核验

- PostHog 当前 Web Session Replay 文档说明可通过手动控制 recording：初始化时关闭自动 recording 后，`startSessionRecording(false)` 创建新的 recording，`stopSessionRecording()` 暂停/停止 recording。手动启动仍受 PostHog 项目级采样/ingestion control 影响，因此“调用成功”不等于“后台一定有回放”。
- PostHog 当前隐私文档列出 `ph-no-capture`、输入掩码与文本 selector/function 掩码等 browser-side 控制；被屏蔽的数据不会发送到 PostHog。第三方支付/认证界面无法可靠屏蔽时，官方建议手动停止/恢复 recording。
- PostHog Cloud 文档称 Session Replay 以每个 session 的加密密钥保护，删除 recording 会销毁该密钥。该说明不等同于「到期自动删除」已按套餐上限生效；当前 Free 套餐最长 30 天，仍须对目标项目实际 retention 设置做环境级验证。
- 参考：
  - <https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record>
  - <https://posthog.com/docs/session-replay/privacy>
  - <https://posthog.com/docs/session-replay/installation/web>
