# T3 Shared contract validation — 2026-10-13

## Scope

T3 exposes only `pref_show_status` and `pref_show_memory` alongside the existing
generation preferences. The public user-settings and generation-config read
models retain all existing fields; both PATCH schemas keep every field optional
and are strict. Backend uses those schemas at its existing PATCH routes.

The repository maps a missing status or memory preference to `true` for public
read models, preserving the database defaults during a partial migration
rollout. No rule-window remaining count and no `chat_history` mode snapshot is
part of a Shared DTO, Zod schema, HTTP response, or route log.

## T4 boundary

This change retains the pre-existing repository update path only so T3's
producer and consumers compile. It does not call
`app_core.update_instruction_slot_preferences`, does not read the turn-claim
result, and does not render or expose `full`, `concise`, or `off`. Those
behaviors remain T4 work.

## Local validation

Run from `/Users/qj/python_project/ST_miniAPP_platform_instruction_slots`:

- `pnpm --filter @miniapp/shared typecheck` — passed.
- `pnpm --filter @miniapp/shared test` — passed: 14 files, 130 tests.
- `pnpm --filter @miniapp/backend typecheck` — passed.
- `pnpm --filter @miniapp/backend test` — passed: 82 files, 643 tests; database integration tests remain excluded by that existing script.

No TEST/Production database operation, remote deployment, or migration apply
occurred for T3.
