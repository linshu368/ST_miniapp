# PRD: Admin VIP Media Configuration

## Background

Operations needs a dedicated Admin menu for VIP-related media configuration. Today basic image generation settings are editable in Admin, while advanced image settings are seeded in `runtime_config` but not exposed as managed configs. Voice/basic-image free-trial count is a shared constant (`FEATURE_FREE_TRIAL_LIMIT = 3`) and cannot be changed without code.

## Requirements

- Add an Admin menu named VIP information/configuration that exposes:
  - Advanced image entry switch.
  - Advanced image per-generation credit price.
  - Advanced image price display label.
  - Advanced image provider/model config.
  - Media free-trial count for voice and basic image.
- Keep existing basic image configuration available and do not remove the current image generation menu unless the final navigation clearly separates basic image and VIP media settings.
- Backend image/voice quota reads must use the runtime-configured free-trial limit instead of a hard-coded shared constant.
- Existing API response shapes should remain compatible; `free_trial_limit` remains numeric.
- Advanced image remains VIP-only and main-credit-only.
- Admin draft/publish/rollback behavior must reuse the existing managed config flow and environment separation.
- Add a database migration under `packages/shared/migrations/` to expose and validate the new/advanced managed config keys.

## Non-Goals

- No new business tables or changes to wallet/ledger settlement tables.
- No change to VIP purchase plans, VIP entitlement calculation, or text-model VIP discount.
- No change to basic image provider secrets currently held in process environment.
- No production migration execution in this task.

## Acceptance Criteria

- Admin shows a VIP config menu with tabs/entries for advanced image and media free trials.
- Admin can edit, save draft, publish, and roll back the new managed config keys.
- Backend `/api/v1/voice/config` and `/api/v1/images/config` reflect the configured free-trial limit.
- Reservation/quota logic rejects exhausted trials according to the configured limit.
- Invalid Admin values are rejected both client-side and by database validation.
- Targeted typecheck/tests pass or any unrun checks are explicitly reported.
