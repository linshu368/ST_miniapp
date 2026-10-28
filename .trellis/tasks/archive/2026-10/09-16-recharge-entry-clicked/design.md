# Design: recharge_entry_clicked

## 复用调研

| 候选                                                        | 结论                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/api/telemetry.ts` 的 `frontendEvent()` | **不复用其必填 `replay_context_id`**。个人中心入口经常没有 chat replay。新建允许缺省 context 的 schema，字段风格对齐 `serverPaymentEvent` / SDK health。 |
| `PaymentFlowLastObservedActionSchema` / `rememberAction`    | **不扩展**。这是入口点击，不是支付流程最后观察动作；混入会污染 `payment_flow_left_observed`。                                                            |
| `captureDraft` / `lifecycle.capture`                        | **不复用发送路径**。二者在无 identity / 无 `replayContextId` 时直接 return，正是本需求要避开的门闩。                                                     |
| `createPostHogAdapter().capture` + `whenReady()`            | **复用**。runtime 仍走 `parseReplayTelemetryEvent`；`whenReady()` 绑定已有 `POSTHOG_SDK_LOAD_TIMEOUT_MS`。                                               |
| `hasActiveReplayContext()`                                  | **复用**，仅用于决定是否附带 ID。                                                                                                                        |
| PostHog `unregister_for_session`                            | **复用**。Replay 结束后移除聊天会话属性；无 context 的主动入口发送前再清理一次，覆盖页面重载留下的旧属性。                                               |
| `captureRechargeViewed`                                     | **保持原语义**，不改触发条件。                                                                                                                           |
| 新通用「无 context 事件框架」                               | **拒绝**。只有这一个产品事件需要可选 context。                                                                                                           |

## 契约

新事件 `recharge_entry_clicked`（加入 `ReplayTelemetryEvent` discriminated union，兼容扩展）：

| 字段                | 约束                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `event`             | `'recharge_entry_clicked'`                                                |
| `telegram_user_id`  | 必填，数字字符串                                                          |
| `occurred_at`       | 必填 ISO datetime                                                         |
| `entry_source`      | `'profile_balance'`（预留枚举，本期仅此值）                               |
| `replay_context_id` | 可选 UUID；无活跃 context 时省略，不发 `null`                             |
| 禁止                | URL、`pay_url`、支付套餐/订单、initData、正文、`user_cohort`；strict 对象 |

不带 `is_paid_user` / `total_chat_rounds`：需求明确只带来源、用户标识、时间和可选 context。

## 发送时序

```text
Profile Link onClick
  -> captureRechargeEntryClicked({ telegramUserId })  // 同步返回
  -> snapshot replay_context_id（仅活跃 chat/followup/pending）
  -> void adapter.whenReady()
       .then(ready => ready && adapter.capture(event))
  -> Next.js Link 照常 push /profile/recharge
```

- `onClick` 不 `preventDefault`、不 `await`。
- `occurred_at` 取点击瞬间，避免 SDK 等待后时间漂移。
- `whenReady()` 若尚无 `initPromise`，立即 false（未配置 / 未 init），丢弃事件。
- init 进行中则等待既有 load timeout；超时或失败则 no-op。
- 无 `telegram_user_id`（页面未解析到且 adapter 无 distinctId）则不发送。
- PostHog 会自动把 `register_for_session` 的旧聊天属性合并到后续事件；`endReplay` 在结束事件发送后清理聊天属性，无 context 的入口点击在 capture 前再次清理，避免旧 `replay_context_id` 混入最终事件。付费墙 followup 和外部支付 pending 仍保留当前属性。

## 可靠性

| 项       | 处理                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 超时     | 复用 adapter `whenReady` / `POSTHOG_SDK_LOAD_TIMEOUT_MS`，不再套第二层死等 |
| 重试     | 不重试。点击是一次性意图；失败即丢失该次分析                               |
| 幂等     | 不按 fingerprint 去重；每次点击一次事件                                    |
| 并发     | 连续点击可能发多次；跳转通常卸载页面，可接受                               |
| 降级     | 未配置 / init 失败 / schema 拒绝：静默，链接可用                           |
| 可观测性 | 禁止键仍由 adapter `event_rejected` 健康事件覆盖；本事件不打业务日志       |
| 容量     | 仅个人中心入口点击，无新网络通道                                           |

## 最小充分方案

- 改动面：shared 契约 + 测试、`flow-telemetry` 一个发送函数 + 测试、profile `Link` `onClick`。
- 不改 lifecycle 门闩、不改充值页、不改 backend capture、不加新 SDK、不加 React Query。
- adapter 只新增清理现有四个聊天会话属性的窄接口，不清 PostHog identity、支付状态或其他会话属性。
- 拒绝：把 `recharge_viewed` 改为无 context；在 recharge 页补发入口事件；新 telemetry client。

## 演进与恢复

- 契约：新增联合成员 + 可选字段，旧客户端忽略未知事件即可。
- 发布：shared 与 frontend 同发；backend 只消费 union 类型，无运行时分支。
- 回滚：去掉 onClick 与 union 成员即停止该事件；`recharge_viewed` 不受影响。
- 未来其他入口：扩展 `entry_source` 枚举，不新开事件名。

## 验证

见 `implement.md`。失败路径：无 context、SDK 未就绪、无用户 ID、禁止键、聊天余额不足原路径。
