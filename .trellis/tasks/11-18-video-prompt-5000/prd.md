# Video prompts up to 5000 characters

The user explicitly requested 5000 after the production diagnosis: video API/input accepts long prompts, but message content CHECK rejects more than 2000. The failure occurs before task creation, reservation or provider invocation. This instruction authorizes the concrete fix described in the diagnosis.

## Requirements and acceptance

- Accept and preserve complete video prompts up to 5000 characters; reject 5001 before any message/task/billing write. Never silently truncate a submitted or historical prompt.
- Share one video request limit between input and API. Preserve image API/input limit 2000. Do not narrow historical response schemas.
- Expand existing message content storage CHECK to 1-5000; keep FKs, RLS, grants, triggers, existing data and billing/idempotency unchanged.
- Verify shared boundaries, consumers, frontend behavior and real local SQL, including replay and unknown-shape rejection.
- No paid generation, historical retry or price changes. Remote migration follows TEST then independently reviewed production workflow. No automatic staging/commit/push.

No unresolved product choices. Counting follows existing JS form/Zod UTF-16 length; 5000 Chinese characters are accepted. PostgreSQL char_length provides the storage bound. Mobile performance/logging plans are fully declared in task.json; no visible independent success baseline exists.
