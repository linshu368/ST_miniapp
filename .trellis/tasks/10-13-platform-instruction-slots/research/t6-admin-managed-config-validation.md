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
both tables. It passed locally. TEST must first confirm the failed apply did
not produce a ledger row, then rerun the same file; no remote retry was made
by this task.
