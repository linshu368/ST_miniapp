# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                           | Files / Scope                                                  | Depends On | Verification                                                    |
| --- | ------ | -------------------------------------------------------------- | -------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| T1  | Done   | Audit tables, RPCs, permissions, and current dev consumers     | existing migrations and repositories                           | -          | Eight tables, three image RPCs, and two billing RPCs identified |
| T2  | Done   | Define direct cutover, release order, and rollback             | `design.md`, `implement.md`                                    | T1         | Planning gates documented                                       |
| T3  | Done   | Implement exposure, M1/rollback SQL, and direct backend access | shared migrations, backend image plaza, and `ops/schema-split` | T2         | SQL assertions and consumer scan                                |
| T4  | Done   | Run relevant tests/static validation and inspect diff          | repository checks                                              | T3         | Backend tests/typecheck, migration lint, and diff review        |

## Execution Log

- Branch created from `origin/dev` at `39a3f799c76461583c0bce7f1a097cc56553e549`.
- Scope excludes all video tables and frontend/admin application code.
- User explicitly rejected old-schema compatibility paths; scope now includes
  the minimum backend changes required for direct `media_plaza` access.
- Local validation passed: backend typecheck, 980 backend tests, migration lint,
  legacy scan, direct ESLint invocation, Trellis context validation, and
  `git diff --check`.
- 2026-10-27 user confirmation: M1 and the PostgREST exposure script have been
  completed in both Supabase TEST and Production. Do not rerun or roll back M1;
  any later shape drift must be handled with a forward-fix. Application merge
  and deployment remain separate release steps.
