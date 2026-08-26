# Supabase And Migration Guidelines

Applies to `packages/shared/migrations`, Prisma schema changes, and Supabase runtime access.

## Pre-Development Checklist

- Read `docs/ST_remove-Supabase瘦身专项.md`.
- Read `docs/ARCHITECTURE.md` sections 5 and 7.4.
- Search code references with `rg` for `.from()`, `.rpc()`, `.schema()`, raw SQL, Prisma models, and repository methods.
- For deletion or slimming work, check database-side references: functions, views, triggers, constraints, and pg_cron.

## Required Rules

- New migrations go under `packages/shared/migrations/`.
- Do not edit historical migration files.
- test and production are not guaranteed to be isomorphic; plan against production and verify test.
- `public` and `analytics` belong to the old bot side. Miniapp migrations must not reference or modify them unless an accepted PRD explicitly says so.
- Deletions require three negative signals: app code, DB internal references, and production read/write evidence.
- Execute migration plans one file at a time, test before production.
- Data exports and sensitive archives must not enter git.

## Quality Check

- Validate idempotency and lock behavior.
- Document rollback where possible.
- Record test/production execution and shape verification in the task.
