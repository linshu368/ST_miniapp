# Implementation and verification

1. Start after recording this explicit post-diagnosis user authorization and complete planning gates.
2. Shared constant/request schema; extend existing tests: 2001/5000 accepted, 5001/blank rejected, image2000 unchanged.
3. Extract studio prompt input; apply shared video limit and pre-quote guard without silently clipping historical input, changing IME/shortcuts/drafts.
4. Forward migration and same-name read-only postflight; local synthetic SQL boundaries/replay/unknown-shape/rollback/ACL checks. Contract/migration risk justifies regression coverage; extend existing tests first.
5. Shared/frontend tests, related Backend tests, all-consumer typecheck, frontend lint/build, complexity/DB/logging gates. Extend existing @image fixture scenario for input boundary rather than one-off browser scripts.
6. Update runtime docs, README/architecture/module payload and verification/review packet. Mark remote/real-device/P95 work separately.

Release uses .github/workflows/db-migrate.yml, one TEST file then postflight, independent production approval then consumers. Stop on unknown shape, lock/statement timeout, permission drift, validation failure, prompt loss or billing/idempotency regression. Do not stage/commit/push before final human review.
