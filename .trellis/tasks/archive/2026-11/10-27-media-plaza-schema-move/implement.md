# Implementation Plan

1. Add `20261027_media_plaza_schema_move.sql` with fail-closed preflight,
   physical catalog moves, canonical function recompilation, grants, and
   postflight assertions.
2. Add guarded TEST and PRODUCTION post-M1 scripts that append the now-existing
   `media_plaza` schema to the exact reviewed `pgrst.db_schemas` value and reload
   PostgREST config.
3. Add the paired rollback with an M2 guard, dependency-safe removal of
   reverse catalog moves, function recompilation, and postflight assertions.
4. Add `media_plaza` to the backend schema registry and retarget all image-plaza
   repository/seed SQL consumers plus existing schema-sensitive tests.
5. Run backend typecheck/tests, migration lint/static validation, and inspect the
   complete diff.
6. In TEST release validation, execute one file at a time and record before/after
   object shape, grants/RLS, row counts, representative read/write/RPC behavior,
   lock observations, rollback readiness, and existing dev app smoke results.

No remote SQL is executed here. Failure-path verification is embedded in the
preflight/postflight blocks; consumer verification requires the TEST environment.
Because no compatibility layer is allowed, TEST/production cutover requires an
image-plaza traffic pause and coordinated backend deployment/rollback.
