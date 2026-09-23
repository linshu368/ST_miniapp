# Implementation Plan

## Steps

1. Shared contract
   - Update `packages/shared/src/api/feature-free-trials.ts` to parse configurable limits while retaining default compatibility.
   - Update wallet/capability helpers and tests to use the default constant through the new helper names.
2. Backend runtime
   - Add a runtime config reader for `media_feature_free_trial_limit`.
   - Thread the limit through `FeatureFreeTrialRepository`, voice config, image config, and empty quota fallbacks.
   - Keep advanced image runtime behavior unchanged except for Admin exposure.
3. Admin
   - Register new managed keys and metadata.
   - Add advanced image provider config schema and editor.
   - Add VIP information/config menu and grouped tab list.
   - Adjust navigation tests.
4. Database migration
   - Add `20260923_admin_vip_media_config.sql` with seed, CHECK extension, whitelist, validation, and self-checks.
5. Validation
   - Run targeted shared/backend/admin tests and typechecks.
   - Record any blocked checks with exact reason.

## Files Expected

- `packages/shared/src/api/feature-free-trials.ts`
- `packages/shared/src/api/wallet.ts`
- `packages/shared/src/__tests__/vip-billing-contracts.test.ts`
- `packages/backend/src/infrastructure/repositories/FeatureFreeTrialRepository.ts`
- `packages/backend/src/features/billing/feature-free-trial-limit.ts`
- `packages/backend/src/features/image/config.ts`
- `packages/backend/src/routes/images.ts`
- `packages/backend/src/routes/voice.ts`
- `packages/admin/src/lib/configSchemas.ts`
- `packages/admin/src/lib/adminNavigation.ts`
- `packages/admin/src/App.tsx`
- `packages/admin/src/components/ConfigValueEditor.tsx`
- `packages/admin/src/lib/adminNavigation.test.ts`
- `packages/admin/src/lib/configSchemas.test.ts`
- `packages/shared/migrations/20260923_admin_vip_media_config.sql`

## Risk Checks

- Free-trial limit must never silently grant more than configured after a reduction.
- Admin provider config must not accept secrets or expose process-env keys.
- Database validation must include all Admin-visible keys, or menu items will save locally but fail at RPC/database boundary.
- Existing image basic config menu must remain reachable.
