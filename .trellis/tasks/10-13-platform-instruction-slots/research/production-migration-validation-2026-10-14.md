# Production migration validation — 2026-10-14

## Scope and target

- Environment: `production`
- Supabase project ref: `wbtsfzozlmurljvglhpn`
- Workflow: GitHub Actions `Database Migration`
- Source ref used by the apply runs: `dev@a069190fe87a808b6fa8bd85341ad0968acd986b`
- Evidence boundary: workflow logs and migration self-checks only; no business rows were read.

## Read-only preflight

- [Run 38576255748](https://github.com/linshu368/ST_miniapp/actions/runs/38576255748) completed successfully with `mode=inspect` against Production.
- The inspect snapshot reported the six runtime migrations below as `not_applied` before the release and reported `drift: 0` for the repository ledger.

## Applied migrations

Each file completed in `mode=apply` against the Production project. The `Applied ... (checksum ...)` line was emitted only after the SQL file, its embedded postflight checks and ledger recording completed.

1. [Run 38577585000](https://github.com/linshu368/ST_miniapp/actions/runs/38577585000) — `20261012_retire_interaction_mode_placeholder.sql` — `998f4a35e5c2fc173c2c3aac70d264c859584d99082cb914894909798e8138c9`
2. [Run 38577746215](https://github.com/linshu368/ST_miniapp/actions/runs/38577746215) — `20261013_accept_rich_reply_protocol_artifact.sql` — `1fd4e7575be75f5f0058adb6ea6c5a392fc2ef234c15d0e845fc592fcb9f7478`
3. [Run 38577924033](https://github.com/linshu368/ST_miniapp/actions/runs/38577924033) — `20261013_admin_platform_instruction_slots.sql` — `ec777e79d85ece6814e3eb1fd62e5fcff27156c3b04c10fe8e730765d8c85dfa`
4. [Run 38578174143](https://github.com/linshu368/ST_miniapp/actions/runs/38578174143) — `20261013_platform_instruction_slot_windows.sql` — `5f7fdd3cdc2ba73c5f8a153bb1e9b2a20b28c7323e9545ac8e8c48d370e7a94b`
5. [Run 38578239006](https://github.com/linshu368/ST_miniapp/actions/runs/38578239006) — `20261013_session_scoped_instruction_slot_modes.sql` — `ff72b1d043907d7bae1425d16a81e2fe81646671b401cb0dd77897dd4e4d5a3e`
6. [Run 38578471546](https://github.com/linshu368/ST_miniapp/actions/runs/38578471546) — `20261014_rich_reply_dynamic_mode.sql` — `5922b3d88f51c9a49425b3af06ca3b36f17674c503dbda091367babc18e30d52`

`20261013_repo_migration_claim_recovery.sql` is not an application runtime dependency and was not needed: no Production checksum drift or failed-claim recovery occurred in this release chain.

## Remaining release evidence

- [Run 38579978877](https://github.com/linshu368/ST_miniapp/actions/runs/38579978877) completed a post-apply Production `mode=inspect`: all six files are `match / applied`; repository summary is `Dated migrations: 58 · not_applied: 16 · drift: 0`. The unrelated historical `not_applied` files were not bulk-applied.
- Verify Production current platform-rule and text-postprocess versions without reading business rows.
- Complete TEST environment interaction and renderer acceptance before closing T7.
