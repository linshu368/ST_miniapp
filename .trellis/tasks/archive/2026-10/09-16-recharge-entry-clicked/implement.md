# Implement: recharge_entry_clicked

## Order

1. Shared：`RechargeEntrySourceSchema`、`RechargeEntryClickedEventSchema`（`replay_context_id` optional），加入 discriminated union。
2. Shared 测试：无 context 合法；有 context 合法；拒绝 URL/`pay_url`/缺用户 ID/非法 source。
3. Frontend：`captureRechargeEntryClicked` 走 adapter `whenReady`+`capture`，点击时快照 context。
4. Profile：「星尘充值」`Link` `onClick` 调用 helper，不阻断 `href`。
5. Frontend 测试：无 context 发送、有 context 附带 ID、whenReady 未完成时同步不阻塞、whenReady false 不发送、payload 无 URL/`pay_url`；`recharge_viewed` 无 context 仍跳过。
6. 验证命令与 typecheck。
7. 归因修正：adapter 用 `unregister_for_session` 清除四个聊天会话属性；Replay 真正结束后清理，无 context 的入口事件发送前再次清理，以覆盖旧页面留下的属性。补 lifecycle、adapter、flow-telemetry 回归验证，确认 followup 期间不清理。

## Validation

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/frontend test -- src/lib/payment/flow-telemetry.test.ts
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
```

人工：Preview Telegram WebView 点个人中心「星尘充值」，PostHog 出现一次 `recharge_entry_clicked`；聊天余额不足进充值仍有原 Replay 事件。
