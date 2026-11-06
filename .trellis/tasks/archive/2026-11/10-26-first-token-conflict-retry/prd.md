# Stop production retry storm

User explicitly requests urgent diagnosis, fix and production deployment. Production has ~94 permanent lifecycle failures per second being retried internally by PostgREST 14.5. Three first-token RPCs misuse serialization_failure SQLSTATE40001 for business conflicts. Their guard conditions remain authoritative; return PT409 without retry.

Scope: one additive experience migration preserving installed bodies/OIDs/ACL and changing only explicit business-conflict SQLSTATEs in begin/prepare/select. No rows, wallet, pricing or quota policy changes. Reuse current functions and existing local PG17/PostgREST harness; no framework or dependency. Transaction, lock5s, statement30s, repeat-safe. No backfill. Rollback before commit; forward-fix after commit, never restore retryable business errors.

Acceptance: all3 permanent cases return HTTP409/PT409 within1.5s; selected delivery unchanged; existing billing/identity/ACL checks pass. TEST apply then production apply through immutable repository workflow. Capture activity/error counters before/after and verify storm ends. User emergency authorization covers commit/push/apply/release; planning reviewed against live schema and failure evidence.
