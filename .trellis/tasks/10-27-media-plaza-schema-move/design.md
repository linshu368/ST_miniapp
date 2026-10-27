# Design

## Ownership and invariants

`media_plaza` becomes the owner of the eight existing image-plaza tables and
the three image-plaza RPC implementations. The backend remains the authoritative
writer through the service role. Billing facts and billing RPC ownership remain
in `billing`. Existing foreign keys, indexes, triggers, RLS state, table ACLs,
and rows follow the table OIDs during `ALTER TABLE ... SET SCHEMA`.

## Reuse research

- Reuse all existing eight tables, three image-plaza functions, two billing
  functions, constraints, policies, and grants; no replacement data model.
- Extend the reviewed M1 migration from the video-plaza planning work, but omit
  every M2/video object.
- Reuse the existing image-plaza repository and tools, changing only their
  schema client/qualified SQL target to `media_plaza`.
- Do not introduce compatibility views, wrapper RPCs, a feature flag, duplicate
  state, or a generalized routing framework.

## Migration shape

1. A preflight transaction verifies the exact prerequisite tables/functions and
   rejects unknown function dependencies.
2. Create `media_plaza`, explicitly restrict schema access, and move the tables
   and canonical image RPCs by catalog operation.
3. Recompile only the five reviewed function bodies whose schema-qualified names
   are textual PL/pgSQL references.
4. Postflight verifies object kinds/counts, RLS/ACL intent, and absence of stale
   references, then reloads the PostgREST schema cache.
5. Register `media_plaza` in the backend domain client and retarget the image
   repository, seed importer/exporter, and translation SQL directly.

## Reliability and recovery

- Timeout: use a 5-second lock timeout and 60-second statement timeout.
- Retry: none inside SQL; a failed transaction rolls back atomically and may be
  retried manually only after diagnosing the cause.
- Idempotency: fail closed if `media_plaza` or compatibility objects already
  exist; this avoids masking a partial or wrong-environment deployment.
- Concurrency/transaction: one transaction holds the catalog locks; no dual
  writes or row copies occur.
- Capacity: catalog moves do not rewrite table rows. Lock acquisition, not row
  volume, is the primary operational risk.
- Degradation: there is no dual-schema compatibility. Pause image-plaza traffic
  during the cutover; run M1 before exposing the now-existing schema, then deploy
  the matching backend immediately.
- Observability: preflight/postflight exceptions name the failed invariant;
  release validation records shape, permissions, RLS, key reads/writes, and app
  smoke results.
- Rate limiting is not applicable to a one-time catalog migration.

## Evolution and rollback

Release order is: pause image-plaza traffic, inspect live PostgREST configuration,
execute M1, execute the environment-specific exposure script, deploy the matching
backend, verify database consumers, then resume traffic. Stop on any
preflight drift or failed postflight assertion. Before video objects exist, the
paired rollback requires removing `media_plaza` from the environment's
PostgREST exposure first, then moves canonical objects back, restores textual
references, and drops `media_plaza`; it must be paired with redeploying the
pre-change backend.
After later migrations, use a reviewed forward-fix instead.

Rejected as unnecessary: copying rows, compatibility views/RPCs, triggers for
dual writes, versioned shadow tables, or a generic schema router.
