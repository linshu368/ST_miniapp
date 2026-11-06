# Verification

## Result

The implementation is complete and remains uncommitted for mandatory human review. No production configuration was changed or published.

## Automated checks

- Shared test suite: 17 files, 207 tests passed.
- Admin test suite: 11 files, 109 tests passed.
- Backend test suite with a 15-second per-test budget: 123 files, 1365 tests passed.
- Focused post-refactor checks: shared model contract 24 tests; backend provider/runtime/recovery 173 tests across 5 files.
- Corrected Surplus Intelligence directory/balance coverage: 3 focused files, 23 tests passed.
- Complete non-integration Backend suite after the correction: 125 files, 1385 tests passed with a 15-second per-test budget.
- Workspace typecheck: all 8 packages passed.
- Backend typecheck and standalone Railway IaC TypeScript check passed after the balance integration.
- Admin client and Admin CLI typechecks passed.
- Admin production build passed; only the existing large-chunk warning remains.
- Legacy lint, direct ESLint import-boundary check and complexity budget passed.
- Focused ESLint for the new monitor, Cron integration and tests passed; the legacy-reference guard was updated only for provider capability metadata and the repository-delegated read-only Surplus recovery scan, then passed.
- `git diff --check` passed.
- Read-only contract checks succeeded against the official/current endpoints: public `GET /v1/models` returned the documented data/architecture/pricing shape, and authenticated `GET /payments/balance` returned HTTP 200 with string `credit_balance_usdc`. The balance probe explicitly kept TLS certificate verification enabled and printed only status, field names and JSON types—no credential, balance value or response body.

## Known validation notes

- The default backend 5-second test budget produced six unrelated route-test timeouts. The complete backend suite passed when rerun with a 15-second budget; no assertion failed.
- The root `lint:imports` script has a PowerShell quoting issue around its redundant inline rule argument. The equivalent repository ESLint command without that argument passed.
- A real Surplus generation was not sent because that would use external credentials and potentially incur cost. The request contract is covered by fixtures and transport tests; a non-production smoke test remains a release step.
- A deliberate full-suite attempt including integration tests could not initialize `ranking-stats.integration.test.ts` because Docker is not installed (`spawnSync docker ENOENT`). The repository's complete non-integration suite then passed; no Surplus assertion failed.

## Manual release checks

1. Configure `SURPLUS_API_BASE_URL` and `SURPLUS_API_KEY` on a non-production backend.
2. Open the Admin model catalog and refresh the Surplus Intelligence directory.
3. Add one Surplus Intelligence text model to a draft and inspect the diff without publishing production configuration.
4. Run one non-production completion, then verify settlement and provider-tagged observability.
5. Call `GET ${SURPLUS_API_BASE_URL}/payments/balance` in the target environment and confirm `credit_balance_usdc` is a non-negative integer-microdollar string before applying Railway IaC; do not use legacy `balance_usdc` / `allowance_usdc`.
6. Run reviewed `railway config plan`, confirm only the alert-monitor worker receives Venice/Surplus provider references, then apply and verify `surplus.balance_monitor.heartbeat` without raw response or account data.
