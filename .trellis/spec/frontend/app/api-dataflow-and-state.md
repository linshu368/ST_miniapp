# Frontend API、数据流与状态管理

## API 层地图

- `client.ts`：唯一通用 HTTP client，拼 `API_URL`、注入 Telegram `X-Init-Data`、解析 shared envelope/错误；只供 `lib/api` 使用。
- `query-client.ts`：QueryClient 单例/SSR 策略；query defaults 在此统一。
- `characters.ts`、`favorites.ts`：大厅角色/最新标记/收藏。
- `conversations.ts`：列表、详情、向前分页、创建/更新/删除、标题规则；`conversation-stream.ts`：发送/重生成 SSE parser。
- `generation-config.ts`、`models.ts`、`model-cache-policy.ts`：生成偏好、模型目录/选择和缓存 freshness。
- `voice.ts`：用户语音配置、会话音频、生成 mutation 和 audio map。
- `payment.ts`：套餐、下单、订单状态轮询、余额、流水、签到、订单 infinite query。
- `telemetry.ts`：`GET /api/telemetry/replay-context` 的 React Query hook；失败不得阻断 replay。
- `settings.ts`、`notifications.ts`、`support.ts`、`wishes.ts`、`invite.ts`、`community.ts`：对应业务域。
- `growth.ts`：Provider 上报使用的纯请求函数；`health.ts`：健康查询；`use-refetch-on-foreground.ts`：可见性恢复；`mock-registry*`：显式开发 mock，不得生产误启。

业务组件只能调用 hooks；Provider 等非组件启动流程可调用明确设计的纯 API 函数。新增 query key 必须集中成 domain key factory；mutation 成功后精确 `setQueryData`/invalidate，不做全局无差别刷新。

## 数据流

`Telegram SDK init → getRawInitData → apiClient header → Backend auth → shared envelope → queryFn → React Query cache → page/component`。所有 URL/path/request/response 类型来自 shared。401/403、业务错误、网络错误和 abort 需保留可区分语义。

SSE：`page → streamConversationTurn(AbortSignal, callbacks) → fetch ReadableStream → shared event parser → 临时消息 state → done 后 cache 收敛`。parser 处理跨 chunk 行、未知/非法事件、HTTP JSON 错误、流中 error 和 EOF；不得在组件另写第二套 parser。

## 四类状态的唯一归属

| 状态              | 工具/位置                             | 例子与禁忌                                                             |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| 服务器状态        | React Query                           | 角色、会话、钱包、订单、通知；不得复制到长期 Zustand                   |
| 跨组件客户端状态  | Zustand                               | `font-scale-store`、`ui-store`、`user-profile-store`；只持 UI/展示镜像 |
| 页面/组件临时状态 | `useState/useReducer/ref`             | Sheet、选项、composer、当前流 delta；卸载后无需共享                    |
| URL/导航状态      | pathname/search params/dynamic params | character/session 回跳、payment returned、tab（需分享/恢复时）         |

`user-profile-store` 合并 Telegram/localStorage/server settings，必须定义优先级；`font-scale-store` 只持显示倍率；`ui-store` 只放跨组件 UI。hydrate 仅在客户端运行，localStorage 异常应降级。不要让 useEffect 在两份状态间无限同步。

## 缓存、并发与恢复

- query 配置合理 `staleTime`、enabled、refetch；轮询仅对 pending/需实时状态开启，后台/终态停止。
- mutation 防双击；乐观更新必须有 snapshot/rollback，金额、订单、奖励等关键数据优先服务端确认。
- 页面切换/unmount 中止可取消读取；写入是否中止取决于后端幂等性，不能因浏览器 abort 假设服务端回滚。
- 网络恢复/前台恢复只刷新需要的 key，限制请求风暴。错误界面给出安全重试；不可重试的 validation/auth 不自动循环。
- mock 必须按模块显式启用，返回 shared shape，并在 production build 中默认关闭。

## Telegram 与敏感边界

`lib/telegram/init.ts` 初始化 SDK；`auth.ts` 提供 raw initData；`user.ts` 解析最小用户字段；`launch-url.ts` 尽早清理 URL 敏感参数；`hooks.ts/index.ts` 封装运行环境。

禁止日志、Sentry 事件、PostHog 事件属性、URL query 和应用错误上报收集完整 initData、支付参数、`pay_url`、token/secret 和消息正文。`sanitizeTelemetry` 只清理已知敏感键，不能替代 Session Replay 的 DOM/输入屏蔽。

### Design Decision: Session Replay 聊天正文例外

**Context**: 产品需要在回放中检查流式节奏和 Markdown 呈现；原规则把消息正文从所有 replay 中排除，无法满足该验收。

**Decision**: 2026-09-15 隐私责任人批准受控例外：用户输入和模型回复可以出现在 Session Replay **画面**中。该例外覆盖即将接入的 PostHog Session Replay，以及现有 Sentry Session Replay（`maskAllText: false`，本期不改）。例外不授权把正文复制到事件、日志或错误上报。支付密码/账号/验证码等输入仍须 browser-side 屏蔽；完整 initData 与 `pay_url` 不得出现在录制 URL 或事件属性中。PostHog Session Replay 保留期以当前套餐上限为准：**当前项目为 Free 套餐，最长 30 天**。60 天仅在升级付费套餐后才可能，不得写成当前能力或验收项。

**Contracts**:

| 通道                                               | 完整 initData / token / secret | `pay_url` 与支付表单               | 聊天正文       |
| -------------------------------------------------- | ------------------------------ | ---------------------------------- | -------------- |
| 应用日志、Sentry 事件、PostHog 事件属性、URL query | 禁止                           | 禁止                               | 禁止           |
| PostHog / Sentry Session Replay 画面               | 禁止                           | 禁止（`ph-no-capture` 或暂停录制） | 允许（已批准） |

**Validation & Error Matrix**:

- 事件 capture 含 message/content/initData/`pay_url` → 丢弃该属性或整事件，不得上报。
- 支付输入未加屏蔽 → 不得开始/继续录制该控件；第三方无法屏蔽时先 `stopSessionRecording`。
- Replay SDK 失败 → no-op，不阻断聊天或支付。

**Good / Base / Bad**:

- Good: 回放能看到流式 Markdown；时间线事件只有 session/order/model id。
- Base: 聊天页录制；充值页敏感输入被屏蔽。
- Bad: `capture('chat_turn_completed', { text: delta })` 或把 `pay_url` 放进 router query 并继续录制。

**Wrong vs Correct**:

#### Wrong

```ts
posthog.capture('chat_turn_completed', { content: assistantText });
```

#### Correct

```ts
posthog.capture('chat_turn_completed', {
  telegram_user_id,
  replay_context_id,
  conversation_session_id,
  character_id,
  selected_model_id,
});
```

**Tests Required**:

- T1 无产品代码，不新增自动化测试。
- 后续 adapter 必须在 runtime schema 拒绝 `content` / `pay_url` / initData 类属性。
- T7 在 PostHog 检索上述敏感字段应为空，并确认已批准的聊天正文只出现在回放画面。
- T7 确认项目套餐为 Free、Session Replay retention 为 30 天（套餐与设置截图）；不得按 60 天验收。

**Related**: `.trellis/tasks/09-15-user-behavior-replay/research/t1-decision-record.md`（含 Free 套餐 30 天保留策略）。本期不做 `user_cohort`。

## Scenario: PostHog Session Replay 与支付回流

### 1. Scope / Trigger

- Trigger: 聊天/付费墙需要 Session Replay 与受限事件；Telegram WebView、Next.js 公开变量、web SDK session 轮转和外部支付回流都与默认假设不同。

### 2. Signatures

- Frontend adapter：`createPostHogAdapter()` / `getReplayLifecycle()`；生命周期状态 `idle | chat | recharge | paywall_followup | external_payment_pending | ended`。`recharge` 是独立的主动充值 context，不带聊天身份。
- Context API：`GET /api/telemetry/replay-context`（Telegram 鉴权，无 query），形状为 `GetReplayContextData`。
- 回流观察：`observePaymentReturn({ source, route })`；`source` 为 `start_param | query_param | webview_resume`。

### 3. Contracts

- 浏览器公开变量：`NEXT_PUBLIC_POSTHOG_KEY`、`NEXT_PUBLIC_POSTHOG_HOST`（必须 HTTPS，无 userinfo/path/query）。
- 服务端密钥：`POSTHOG_API_KEY` / `POSTHOG_HOST` 只在 Backend；缺省 no-op。
- Next.js 只内联静态 `process.env.NEXT_PUBLIC_*`。`readPostHogBrowserEnv` 必须直接读 `process.env.NEXT_PUBLIC_POSTHOG_KEY/HOST`，禁止 `const env = process.env; env.NEXT_PUBLIC_*`。
- web `posthog-js` 开始新段：先 `sessionManager.resetSessionId()`，再 `startSessionRecording({ sampling, linked_flag, url_trigger, event_trigger })`。`stopSessionRecording()` + `startSessionRecording(overrides)` **不会**轮转 `$session_id`；禁止调用会丢掉 identity 的 `reset()`；禁止把移动端 `startSessionRecording(false)` 用在 web。
- 录制 owner 在根 `Providers` 的 `ReplayLifecycleOwner`，不能放在会随路由卸载的 `use-chat-session` cleanup。
- 进入付费墙必须先**同步调用** `enterPaywallFollowup()`（内部立刻置 `paywallHold`），再 `router.push`。`push` **不得** `await` lifecycle 队列 / `whenReady()` / SDK import。continuation 的 `triggerSource` / `returnTo` / `requiredCredits` 在 push 前同步写入；`replay_context_id` 与 `paywall_triggered` 在 queue settle 后补丁，失败则降级，不得挡住跳转。hold/followup 期间忽略 `route_change`/`pagehide`；同角色重绑保持原 `replay_context_id`；回到聊天再 `reenterChatFromFollowup()`。
- `loadSdk()` / `initPromise` 必须有显式超时（`POSTHOG_SDK_LOAD_TIMEOUT_MS`）；超时视为 `init_failed`，保证 `whenReady()` 有限时间内 settle，lifecycle 串行队列不得被动态 import 永久占住。
- 打开外部支付前写入 `st.replay.external_payment_pending` 并 `enterExternalPaymentPending()` 同步停录，再 `openLink`。无效支付 URL 不进入 pending；`pagehide`/hidden 证据写回 pending，可信回流后 `resumeRecording()`，不轮转 `$session_id`。新文档只在 pending 未过期且有离开证据或显式回流时恢复 MiniApp 内录制，不伪造聊天身份；初次跳转订单页不能立即恢复。Telegram 冻结恢复时 URL 通常不变；根上 visibility/focus/pageshow 在有离开证据时发一次 `payment_return_observed(return_source=webview_resume)`。同一 `order_id` 去重；普通前后台、刷新、VPN 弹窗 focus 不误报。
- `pay_url` 只进 order-id keyed 的短 TTL `sessionStorage`，不得进 router query / 事件属性 / 回放 URL。

### 4. Validation & Error Matrix

- 缺 KEY/HOST 或 host 非 HTTPS → adapter `missing_config`/`invalid_host` no-op，聊天/支付继续。
- SDK 动态 import 超时或抛错 → `init_failed` no-op，聊天/支付继续；`whenReady()` 必须 settle。
- `startNewRecording` 以 `sessionRecordingStarted()` 为准，不得把 SDK 调用返回值当成已在录。
- capture 含禁止键（`content`/`pay_url`/`initData` 等）→ runtime schema 丢弃。
- 个人中心「星尘充值」点击同步保留主动充值 context；SDK 尝试启动录制后发送 `recharge_entry_clicked`（`entry_source=profile_balance`），充值页事件等待同一启动尝试。不能给它伪造聊天会话。`onClick` 不得 `await whenReady()`/`init`；SDK 未配置或失败时链接照常跳转。不得与 `recharge_viewed` 混为一项。
- `register_for_session` 的聊天属性会自动进入后续 PostHog 事件；Replay 真正结束且 `replay_chat_ended` 发出后需用 `unregister_for_session` 清理四个聊天关联属性。主动充值在 SDK 就绪后再清理一次，以覆盖初始化前 no-op 和页面重载留下的旧值；聊天 followup 期间不得清理。
- 无真实 `conversationSessionId` → 不 `startChatReplay`。
- 未配置 Backend `POSTHOG_API_KEY` → 不发服务端终态事件，也不反查用户；结算仍成功。
- pending 订单与 `payment_flow_left_observed` 都不是支付失败。

### 5. Good/Base/Bad Cases

- Good: 两张角色卡两条 `$session_id`；付费墙到充值同一 `replay_context_id`；切回 Telegram 且 URL 不变时一次 `payment_return_observed` 与 status 事件同一 `order_id`。
- Base: Preview 注入公开变量，Production 留空即关闭；Sentry Replay 维持现有 100% / `maskAllText: false`。
- Bad: 经 `process.env` 对象读公开变量导致 Preview 零 recording；`enterPaywallFollowup` 排队后被 occupancy `route_change` 掐断；`await enterPaywallFollowup()` 后再 push，SDK chunk 挂起导致付费墙跳转静默卡死；只认 `?payment=returned` 导致 WebView 恢复无回流事件。

### 6. Tests Required

- `config.test.ts`：静态 env 读取与非法 host。
- `adapter.test.ts`：`resetSessionId` + override start；schema 拒绝禁止键；SDK import 超时后 `init`/`whenReady` settle 且忽略迟到的 load；`recharge_entry_clicked` 无 `replay_context_id` 可发送，旧聊天会话属性可清除。
- `lifecycle.test.ts`：paywall hold、同角色重绑、followup 忽略 `route_change`；真正结束后才清除聊天会话属性。
- `recharge-redirect.test.ts`：调用 followup 后立即 push；continuation 在跳转前写入；`paywall_triggered` 等队列 settle。
- `flow-telemetry.test.ts`：回流去重/误报；`recharge_entry_clicked` 先保留 context 再排入录制队列，payload 无 URL/`pay_url`；`recharge_viewed` 无 context 仍跳过；SDK 尚未接收的订单状态可重试。
- `return-observer.test.ts`：有离开证据才 `webview_resume`；同 order 去重；无 pending 不误报。
- shared `telemetry-contract.test.ts`：`return_source`、禁止键、`user_cohort` 不存在、`recharge_entry_clicked` 允许没有 `replay_context_id`。

### 7. Wrong vs Correct

#### Wrong

```ts
function readEnv(env = process.env) {
  return { key: env.NEXT_PUBLIC_POSTHOG_KEY, host: env.NEXT_PUBLIC_POSTHOG_HOST };
}
posthog.startSessionRecording(false);
await lifecycle.enterPaywallFollowup();
router.push(rechargePath);
```

#### Correct

```ts
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
client.sessionManager?.resetSessionId();
client.startSessionRecording({
  sampling: true,
  linked_flag: true,
  url_trigger: true,
  event_trigger: true,
});
const followup = lifecycle.enterPaywallFollowup();
writePaywallContinuation({ ...snapshot.replayContextId });
router.push(rechargePath);
void followup.then(() => {
  patchPaywallContinuation({ replayContextId: snapshot.replayContextId });
  lifecycle.capture({ event: 'paywall_triggered', ... });
});
```
