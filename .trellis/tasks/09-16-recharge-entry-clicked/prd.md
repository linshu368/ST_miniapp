# 个人中心星尘充值入口点击埋点

## Goal

用户从个人中心主动点击「星尘充值」时，也能留下一条独立分析事件。当前支付路径埋点依赖 Replay context（通常来自聊天余额不足），直接从个人中心进入会被跳过。

## Requirements

- 在个人中心「星尘充值」链接的 `onClick` 中发送 `recharge_entry_clicked`，保留原有 `/profile/recharge` 跳转。
- 事件只带固定来源 `profile_balance`、用户标识和时间；若点击时已有 Replay context，再附带其 ID。不得传页面完整 URL、`pay_url` 或支付信息。
- 契约定义在 `packages/shared/src/api/telemetry.ts`，允许没有 `replay_context_id`。经现有 PostHog adapter 发送；SDK 仍在初始化时异步等待其有限超时，埋点不得阻塞点击跳转。
- 现有 `recharge_viewed` 保持「实际看到充值页」语义，不得与入口点击混为一项。
- PostHog 未配置或初始化失败时，链接照常可用。从聊天余额不足进入时，原有 Replay 关联事件仍正常。

## Acceptance Criteria

- [ ] 个人中心主动点击「星尘充值」产生一次 `recharge_entry_clicked`，`entry_source=profile_balance`，含 `telegram_user_id` 与 `occurred_at`。
- [ ] 无 Replay context 时事件仍发送且不含 `replay_context_id`；有活跃 Replay context 时附带该 ID。
- [ ] 聊天 Replay 结束后、以及页面重载后无活跃 context 的入口点击，不继承 PostHog 会话中旧的聊天关联属性；付费墙 followup 期间仍保留关联。
- [ ] 事件属性不含页面完整 URL、`pay_url`、支付信息、initData 或聊天正文。
- [ ] `recharge_viewed` 仍只在充值页查看时按原规则发送，且仍要求 Replay context。
- [ ] 从聊天余额不足进入充值时，`paywall_*` / `recharge_viewed` 等既有关联事件不被这次改动破坏。
- [ ] PostHog 未配置或 SDK 初始化失败时，点击仍跳转充值页。
- [ ] `pnpm --filter @miniapp/shared test`、frontend 相关测试、以及 shared/frontend（及受影响消费者）typecheck 通过。
- [ ] Preview Telegram WebView 实测可在 PostHog 看到该事件写入（人工）。

## Notes

- 本期只覆盖个人中心余额卡入口，不新增大厅/其他入口来源值。
- 不把 `recharge_entry_clicked` 写入 `last_observed_action`。
