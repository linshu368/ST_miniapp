# Implement: 签到分档与 VIP 绝对额

## Order

1. Migration：新 key、VIP 整数校验、claim_daily_checkin、seed、SQL 场景测。
2. Shared：vip-strategy / vip / 分档 helper。
3. Backend：checkin-reward、vip-status、vip-strategy、wallet repository/routes。
4. Admin：configSchemas、VipStrategyView、vipStrategyForm。
5. Frontend：VIP/充值/presentation 文案。
6. docs/ARCHITECTURE + typecheck / 既有测试。

## Validation commands

```bash
pnpm --filter @miniapp/shared test -- vip-strategy vip-billing
pnpm --filter @miniapp/backend exec vitest run src/features/vip
pnpm --filter @miniapp/admin exec vitest run src/lib/vipStrategyForm.test.ts src/lib/configSchemas.test.ts
pnpm --filter @miniapp/frontend exec vitest run src/lib/vip/presentation.test.ts
pnpm -r --filter @miniapp/shared --filter @miniapp/backend --filter @miniapp/admin --filter @miniapp/frontend typecheck
```
