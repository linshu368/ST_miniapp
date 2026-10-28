# T6 Admin managed-config validation — 2026-10-13

## Scope

T6 adds the Admin-only integration for the independently published
`choice_rules`, `status_rules`, and `memory_rules` runtime keys. Each value
uses T4's Shared `InstructionSlotRulesSchema` and its exact three fields:
`on_first_two_turns`, `on_later_turns`, and `off`.

The Admin workbench has one platform-rules entry with four ordered tabs:
choice, status, memory, and the body template. Tabs select a managed key and
reuse the existing environment-bound draft, publish, release-history, and
rollback card. No second draft store, HTTP client, DTO, or runtime-mode
display was introduced.

`20261013_admin_platform_instruction_slots.sql` is a forward migration. It
seeds only absent slot keys, extends the managed-key allowlist and draft/release
CHECKs, validates exact JSONB shape, and requires the five current body-template
placeholders. It leaves `interaction_mode_blocks` untouched and outside the
new Admin entry. It was not applied to any remote environment.

## Local results

From `/Users/qj/python_project/ST_miniAPP_platform_instruction_slots`:

- `pnpm --filter @miniapp/admin typecheck` — passed.
- `pnpm --filter @miniapp/admin test` — passed: 12 files, 97 tests.
- `pnpm --filter @miniapp/admin build` — passed; Vite emitted the pre-existing
  large-chunk advisory only.
- `pnpm --filter @miniapp/shared typecheck` — passed after consuming T4's
  schema export.
- `pnpm lint:migrations` — passed.
- `pnpm test:migration-ledger` — passed.
- `git diff --check` — passed.

The initial sandboxed Admin test could not create Vite's local temporary
directory. The same local test/build was rerun with filesystem approval and
passed; neither command used a remote service or database.

## Environment and release boundary

The existing `environment.ts` client selection, reload-on-environment-change,
and production write confirmations remain the only environment boundary. T6
validated their continued reuse in source and did not perform TEST or
Production draft save, publish, rollback, migration preflight/apply/postflight,
deployment, commit, or push.

T7 still owns the separately authorized TEST then Production single-file
migration evidence and live managed-config draft/publish/rollback checks. T1-P
also remains: Production's published postprocess tag protocol must be verified
read-only before Production release.

## TEST apply failure recovery — 2026-10-13

The first TEST apply of `20261013_admin_platform_instruction_slots.sql` stopped
at the replacement `admin.config_drafts` key CHECK: eight existing draft rows
and eight release rows use `miniapp_text_postprocess_config`. This is the
current immutable text-postprocess version pointer and its dedicated release
history, not an obsolete generic managed-config key. The migration transaction
rolled back, so no partial validator, constraint, or runtime-config change was
left behind.

The corrected CHECKs accept either the generic
`admin.is_managed_config_key(config_key)` allowlist or exactly
`miniapp_text_postprocess_config`. The special key remains outside the generic
allowlist, preserving its dedicated-RPC write guard and preventing generic
Admin configuration from gaining a new write path. `interaction_mode_blocks`
remains rejected.

`bash scripts/test-admin-platform-instruction-slots-local.sh` now creates an
isolated PostgreSQL 17 cluster with eight historical special-key drafts and
releases, applies the T6 migration, preserves those rows, proves the generic
allowlist remains false for the special key, and rejects an arbitrary key in
both tables. It passed locally.

The failed transaction did leave a `repo_migration_claims` row, because the
repository runner claims a file before submitting its SQL transaction. The
claim therefore keeps the original checksum even though the SQL rollback left
no T6 schema changes. The corrected same-name T6 file must not be retried
directly: that would correctly raise `MIGRATION_CHECKSUM_DRIFT`.

`20261013_repo_migration_claim_recovery.sql` adds the minimal platform-ledger
support for a controlled recovery: `repo_migration_events.details` and the
`abandon_claim` event action. The `Database Migration` workflow now has an
explicit `abandon_claim` mode. It requires a non-empty reason, a missing
ledger row, an existing claim whose checksum differs from the current file,
and the recovery-ledger migration. In one transaction it locks the claim,
rechecks those invariants, records the old checksum, replacement checksum and
reason, then deletes the claim. It does not execute the target migration SQL.

Local `pnpm test:migration-ledger` passed with a simulated failed record,
subsequent fixture checksum change, failure without a reason, audited
abandonment, and normal corrected-file apply. The recovery migration itself
was applied only to the local temporary test database. No TEST/Production
database write or retry was performed.

### Required TEST recovery order

1. Apply `packages/shared/migrations/20261013_repo_migration_claim_recovery.sql`
   through the normal `apply` workflow and retain its ledger/postflight output.
2. Run the workflow in `abandon_claim` mode for
   `packages/shared/migrations/20261013_admin_platform_instruction_slots.sql`,
   with a factual failure reason. Verify the resulting event has action
   `abandon_claim`, the old and replacement checksums, and no ledger row for
   T6.
3. Apply the corrected T6 migration normally, then perform its SQL postflight
   and the planned Admin draft/publish/rollback acceptance. Do not use
   `force_rerun`; it cannot bypass checksum drift.
