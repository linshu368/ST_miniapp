# Design: Admin VIP Media Configuration

## Reuse Research

- Admin managed config flow:
  - Reuse `packages/admin/src/lib/configSchemas.ts` for key registry, Zod validation, labels, descriptions, and defaults.
  - Reuse `packages/admin/src/lib/adminNavigation.ts` for grouped menu routing and tab definitions.
  - Reuse `packages/admin/src/App.tsx` shared `configEditorCard` for draft/save/publish/rollback and release history.
  - Reuse `packages/admin/src/components/ConfigValueEditor.tsx` controlled editor pattern.
- Backend runtime config:
  - Reuse `packages/backend/src/platform/runtime-config.ts` via feature-level config readers.
  - Extend existing `features/image/config.ts` advanced image keys already read by backend.
  - Extend `FeatureFreeTrialRepository` and `feature-free-trials.ts` instead of introducing a second quota source.
- Shared contracts:
  - Keep `FeatureFreeTrialQuotaView.free_trial_limit` numeric and compatible.
  - Add a runtime-config key/schema helper for media free-trial count so shared tests can lock semantics.
- Database:
  - Reuse `app_core.runtime_config`, `admin.config_drafts`, `admin.config_releases`, `admin.is_managed_config_key`, and `admin.validate_managed_config_value`.
  - Existing `20260922_media_feature_free_trials.sql` seeded advanced-image keys but did not expose them to Admin; new migration should add them to managed config validation/constraints.
- Not reused:
  - Do not create a bespoke Admin VIP API. The managed config RPCs already provide environment-aware draft/release/audit semantics.
  - Do not make a new table for free-trial limits; there is one global scalar config.

## Proposed Shape

### Runtime Config Keys

- Existing advanced image keys to expose:
  - `image_advanced_enabled`
  - `image_advanced_generation_credits`
  - `image_advanced_price_label`
  - `image_advanced_provider_config`
- New free-trial key:
  - `media_feature_free_trial_limit`

Default free-trial limit remains `3`. The key applies to the two features currently using free trials: `voice` and `basic_image`. Advanced image stays VIP-only and does not use free trials.

### Shared Contract

- Replace constant-only logic with:
  - `DEFAULT_FEATURE_FREE_TRIAL_LIMIT = 3`
  - `MediaFeatureFreeTrialLimitSchema`
  - `parseMediaFeatureFreeTrialLimit(value)`
- Keep exported `FEATURE_FREE_TRIAL_LIMIT` as compatibility alias for default/test baselines.
- Relax ordinal/quota schemas from literal max 3 to positive bounded integer where needed.

### Backend

- Add `features/billing/feature-free-trial-limit.ts` to read `media_feature_free_trial_limit`.
- Update `FeatureFreeTrialRepository.quota` / reservation summary to accept a limit from runtime config.
- Update voice/image config builders and empty quota fallbacks to use runtime limit.
- Existing reservation facts keep their ordinal. If operations lowers the limit below occupied ordinals, quota should treat slots above the limit as invalid/overflow and report remaining 0. This avoids granting extra trials after a limit reduction.

### Admin

- Add a VIP config view/menu in `adminNavigation`.
- Group keys:
  - `media_feature_free_trial_limit`
  - `image_advanced_enabled`
  - `image_advanced_generation_credits`
  - `image_advanced_price_label`
  - `image_advanced_provider_config`
- Add schema/editor for advanced provider config with provider enum `liaobots_grok | replicate_z | ""` and model string. It does not store provider secrets; those remain backend environment variables.
- Keep the existing image generation config menu for basic image/text prompt settings.

### Migration

Add `packages/shared/migrations/20260923_admin_vip_media_config.sql`:

- Insert `media_feature_free_trial_limit` default `3`.
- Ensure advanced-image runtime rows exist with safe defaults if a DB missed `20260922`.
- Extend draft/release config-key CHECK constraints by OR-ing the new keys.
- Replace `admin.is_managed_config_key` to include new keys.
- Replace `admin.validate_managed_config_value` with branches for:
  - Boolean advanced image switch.
  - Positive integer advanced image price.
  - Nonempty advanced price label.
  - Advanced provider config object: empty object allowed; otherwise provider + model must be complete and provider must be supported.
  - Positive integer media free-trial limit with a conservative upper bound.
- Preserve existing validation branches by delegating to `admin.validate_managed_config_value_before_payment_prompt` or existing helper branches as in the current latest migration pattern.

## Reliability Design

- Timeouts/retries: no new external calls. Admin writes continue through existing Supabase RPCs and do not add client retries.
- Idempotency: migration uses `INSERT ... ON CONFLICT DO NOTHING` and `CREATE OR REPLACE FUNCTION`; config publish/rollback reuse existing Admin idempotency/audit semantics.
- Concurrency: runtime config versions are already managed by Admin draft/release flow; no custom concurrent writer path.
- Transactions: migration runs in a single transaction with lock/statement timeouts.
- Degradation: backend falls back to default limit 3 and safe advanced-image defaults if config is absent/malformed, matching current runtime-config behavior.
- Observability: no new logs needed on hot path unless runtime config parse fails; existing runtime readers log/fallback where applicable.
- Capacity: changing a scalar limit does not scan or rewrite historical trial rows.

## Evolution And Recovery

- Deployment order: migration first, then backend/admin code. Code has fallback defaults, so partial deployment is safe.
- Rollback:
  - Forward-fix preferred: publish safe values (`media_feature_free_trial_limit = 3`, `image_advanced_enabled = false`).
  - Code rollback remains compatible because new runtime_config rows are ignored by older code.
  - Migration rollback can remove keys from managed whitelist and reset functions, but deleting runtime rows is optional and not required for safety.
- Old data:
  - Existing reserved/consumed rows with ordinals 1..3 remain valid.
  - If operations reduces limit, users with consumed/reserved rows above the new limit simply have no remaining free trials.

## Verification Plan

- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/backend test`
- `pnpm --filter @miniapp/backend typecheck`
- `pnpm --filter @miniapp/admin test`
- `pnpm --filter @miniapp/admin typecheck`
- Migration static review and, if available, local/test DB syntax execution via project migration workflow.
