# Implementation plan

1. Review the final PRD/design/task, protocol evidence, new regression-test scope, old-order disposition and the user-selected documented GET lookup. Only then run task.py start. No product code during planning.
2. Implement concrete epay gateway and small provider-independent internal contract reused by existing consumers. Add external callback schema in shared first. Implement exact lowercase MD5/form encoding, strict response validation and deadline/error handling.
3. Wire client IP, creation, early GET notification, polling and return into existing recharge/settlement. Keep exact three-decimal amount validation and safe unknown-result recovery. Split touched oversized functions/files.
4. Adapt reconciliation/expiry to bounded, fair single-order queries and explicit history isolation; safe failure must retain recovery. Update scripts, diagnostics and obsolete webhook management.
5. Update central config/env example, Railway payment-service references and per-environment notify URL, root README, architecture, operational docs and relevant specs. Never copy credentials into task artifacts or run unspecified-environment jobs.
6. Implement the reviewed protocol/security regressions and adapt existing payment tests. Extend only existing UI fixtures/groups if needed/approved.
7. Execute checks below, review all affected consumers, document baseline failures and manual/provider/P95 gaps. Prepare module-updates.json matching module_impact and validate it before final human review.
8. Present final paths/diff digest/check results and safe release/recovery instructions. Do not stage, commit, push or deploy without the corresponding required review/authorization.

## Verification commands

```powershell
pnpm --filter @miniapp/backend exec vitest run src/infrastructure/payment src/features/payment src/routes/payment.test.ts
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm lint:imports
pnpm lint:legacy
pnpm lint:complexity
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm test:ui --grep @recharge
git diff --check
```

Check/format only explicit changed non-secret files. Backend has no build script; typecheck/tests validate it. When eliminating complexity entries run `node scripts/complexity-budget.mjs update` and inspect reductions. Real provider/jobs must not be called against an unspecified DB environment; no live database access or actual charges in ordinary tests.

## Failure and manual acceptance

| Case                                                                       | Expected                                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Wrong signature/application/channel/order/ref/amount, duplicate query keys | No fulfilment, safe documented negative acknowledgement.                                                                      |
| Concurrent/duplicate callback-query-job, credits and VIP                   | Exactly one durable fulfilment and correct original product snapshot.                                                         |
| Callback before provider-ref write, lost callback, late paid order         | Existing settlement boundary recovers without foreign-ref overwrite or double benefits.                                       |
| Timeout after creation, DB failure then retry                              | No blind duplicate creation or false durable success; later trusted query/callback recovers.                                  |
| Partial/slow query pass, status=0, 429/5xx                                 | Bounded work, fair progress, no invented unpaid finality/destructive expiry.                                                  |
| Old Vexutopia order                                                        | Historical display preserved, no TTZF query or mistaken settlement.                                                           |
| Android/iOS Alipay/WeChat                                                  | Real app handoff, reopen, Telegram return, paid amount/benefits validated separately from fixtures.                           |
| Real GET query probe                                                       | Provider returns a valid authenticated order/not-found response using the documented GET flow; real credentials are required. |

## Release gates

The user explicitly selected the documented GET lookup after clarification. Actual authenticated lookup, provider trade reference format and HTTPS checkout still need live evidence. Local test fixtures do not establish those facts. Human must review final planning artifacts before implementation and final diffs before staging/commit.

## Follow-up: optional param removal (user requested 2026-11-09)

- Remove param from create payload and required shared fields; remove environmentTag and callback/query param comparisons.
- Keep raw signed legacy extensions, merchant/order/channel/reference/amount checks, unknown-order rejection and atomic fulfilment.
- Extend existing gateway/contract/payment route tests for absent/empty/legacy param and tampering. Run shared/backend tests, consumer typechecks and applicable lint/build checks.
- Update README, architecture and payment specs; report real-provider recovery as unverified until deployed and checked. Do not deploy, stage or commit without the required final review.
