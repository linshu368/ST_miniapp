# T2 local migration validation — 2026-10-13

## Scope and boundary

This is a repeatable local-only verification of
`packages/shared/migrations/20261013_platform_instruction_slot_windows.sql`.
It creates a disposable PostgreSQL 17 cluster reachable only through a Unix
socket below `/private/tmp`, bootstraps the minimum 20260930
current-postprocess wrapper precondition, applies the single T2 migration, and
removes the cluster on exit. It does not read or write TEST or Production.

Run from the repository root:

```bash
scripts/database/test-platform-instruction-slot-windows-local.sh
```

`POSTGRES_BIN` may override the default PostgreSQL 17 binary directory. The
runner fails before creating a cluster when the selected directory lacks its
required PostgreSQL tools.

## Passed scenarios

- Preserves historic `pref_show_options=false`; defaults new status/memory
  preferences to true and initializes each independent remaining counter in
  the 0..2 range.
- Allocates full/full/concise independently for choice, status and memory.
- Applies off mode without consumption, then resets only the corresponding
  counter on false-to-true and assigns full again after reopening.
- Reuses all three stored modes for same-turn regeneration without consuming a
  further counter.
- Starts three simultaneous sessions for one user and observes exactly two
  `full` and one `concise` allocation, with the remaining counter at zero.
- Injects a failure after the claim and observes neither history nor consumed
  counters after the statement rolls back.
- Rejects direct mode/counter changes with the migration guards; verifies
  owner `postgres`, `SECURITY DEFINER`, fixed `search_path=pg_catalog`, no
  PUBLIC/anon/authenticated execute on the turn RPC, RLS on the two tables,
  intended view grants, and the `security_invoker` current-history view.

## Result

The command passed on 2026-10-13 with local PostgreSQL 17.11. No T2 migration
defect was found. The runner itself was adjusted to use `/private/tmp` because
the host's default macOS temporary directory exceeded PostgreSQL's Unix-socket
path limit, and to select PostgreSQL 17 because PostgreSQL 14 lacks
`security_invoker` view support. Neither adjustment changes the migration.

## Remaining remote gate

TEST and Production still require their separately authorized, single-file
preflight/apply/postflight evidence. In particular, verify target-environment
ledger/shape, function owner/search path/ACL, RLS/grants, concurrent allocation
and rollback behavior before advancing a release; this local result is not
evidence of remote deployment.
