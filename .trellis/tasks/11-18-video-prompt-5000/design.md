# Design

## Reuse and minimum scope

Inspected SubmitVideoPlazaAttemptRequestSchema, IMAGE_PLAZA_PROMPT_MAX_CHARS, contract tests, video route/createAttempt and reservation ordering, studio textarea/generateVideo, live production catalog columns/CHECK/triggers/service grants, migration postflight/PGlite harness. Reuse shared video-plaza.ts, existing draft/actions, message table, HTTP observation and migration workflow. Add VIDEO_PLAZA_PROMPT_MAX_CHARS=5000 and narrow only new requests. Extract the textarea from the oversized studio function. No new API, state source, dependency or generic validation framework.

Database placement: media_plaza.image_plaza_messages.content, existing E content with the same writer/lifecycle. Change only its named CHECK to 1-5000; no new table/column/jsonb/function. Image entry points remain 2000. Accept known 2000 or target 5000 constraint shapes only; unknown shape fails and target replay is a no-op. Transaction, lock_timeout 5s, statement_timeout 30s; NOT VALID then VALIDATE. No data rewrite, permission or billing change.

## Reliability and recovery

Shared validation rejects >5000 before repository writes; client rejects before quoting, including historical retries. No additional network call. Existing deadlines, idempotency, concurrency, worker leases, limits and refunds remain; no new retries/compensation. DDL lock/validation failure rolls back. Unknown commit results require catalog/ledger reconciliation, not blind force_rerun. Table validation cost must be checked per environment.

Publish TEST migration/postflight, then independently reviewed production migration, then Backend/Frontend. Existing readers accept wider storage. The previous unlimited video request behavior is intentionally narrowed to the user-selected 5000. Roll back consumers while retaining wider CHECK; shrinking to 2000 would reject already stored long messages and requires separate reviewed data handling. Never truncate/delete as rollback. Provider-specific prompt constraints may still independently reject a request.

## Observability/performance

Reuse http.request 400/202/500 terminal, request_id/trace_id and db.supabase status/duration. No prompt logging or new alert/telemetry pipeline. Migration uses workflow audit. Android/iOS studio ready target1500ms, submit API800ms; baselines null, before/after24h split platform/release, N<100 extend72h. Validation adds no loading call; local boundary tests do not prove real P95.
