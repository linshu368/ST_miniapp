# T4 Backend validation — 2026-10-13

## Scope and boundary

T4 consumes the T2 RPC result without exposing its internal state. Preference
patches send only the three slot booleans to
`app_core.update_instruction_slot_preferences`; all other settings retain the
existing repository update path. The RPC is the sole Backend write path for
these booleans, so a false-to-true reset cannot be replaced by a normal direct
update.

The turn-start and regeneration wrappers return three persisted modes. The
repository validates all values as `full`, `concise`, or `off`; a missing or
invalid result fails before prompt creation, generation, SSE, or billing.
Modes are passed only through Backend internal types. They, remaining counts,
and `chat_history` snapshots are absent from Shared HTTP/SSE DTOs.

`choice_rules`, `status_rules`, and `memory_rules` use the strict Shared
`InstructionSlotRulesSchema`, exported from the package root for Admin's
consumer. Backend reads every key independently, includes each version in the
cache signature, uses a no-markup safe fallback for an invalid key, marks the
snapshot degraded, and logs only key/version/status summaries—not rule text.

## Local validation

Run from `/Users/qj/python_project/ST_miniAPP_platform_instruction_slots`:

- `pnpm --filter @miniapp/shared test` — passed: 15 files, 132 tests.
- `pnpm --filter @miniapp/backend test` — passed: 82 files, 647 tests;
  existing database integration tests remain excluded by that script.
- `pnpm --filter @miniapp/shared typecheck` — passed.
- `pnpm --filter @miniapp/backend typecheck` — passed.
- `git diff --check` — passed.

The focused regression coverage verifies strict rules schema parsing, per-key
fallback/degraded logging without rule text, all three rendering modes, retired
`INTERACTION_MODE` non-consumption, and rejecting incomplete turn RPC mode
payloads. T2's local PostgreSQL harness remains the evidence for concurrent
claims, regeneration reuse, and transaction rollback; T4 does not rerun or
modify that migration/harness.

## Remaining boundary and risks

No TEST/Production SQL, config write, deployment, commit, or push occurred.
T5 is still responsible for Frontend preference controls. T6 owns Admin's
managed-config UI and migration; this task only supplies its Shared schema
export. T7/T1-P retain the environment-level migration, published-config, and
Production tag-protocol gates. Until the relevant migrations are applied, the
new Backend fails closed on a missing mode payload rather than guessing a mode.
