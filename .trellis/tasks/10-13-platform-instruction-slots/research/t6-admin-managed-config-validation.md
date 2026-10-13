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
