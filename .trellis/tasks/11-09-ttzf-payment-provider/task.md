# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                     | Files / Scope                                      | Depends On | Verification                                     |
| --- | ------ | ------------------------------------------------------------------------ | -------------------------------------------------- | ---------- | ------------------------------------------------ |
| T1  | Done   | Read specs/current payment implementation and supplied screenshots       | Existing source and user documentation             | -          | design.md evidence/reuse table                   |
| T2  | Done   | Human planning review, old-order/query recovery decisions and task start | PRD/design/implement/task.json                     | T1         | Reviewed plan and in_progress status             |
| T3  | Done   | Epay gateway/signatures/shared external callback schema                  | infrastructure/payment, shared/api/payment         | T2         | Protocol/security regressions                    |
| T4  | Done   | Creation, notification, polling/return, exact settlement                 | routes/payment, RechargeUseCase, PaymentSettlement | T3         | Existing and reviewed failure-path tests         |
| T5  | Done   | Fair bounded reconciliation and history isolation                        | reconciliation, repository, payment scripts        | T4         | Slow/partial/duplicate/legacy cases              |
| T6  | Done   | Config/deployment references/diagnostics/docs                            | config, Railway/PR workflow, README/spec/ops       | T5         | Build/static checks and configuration review     |
| T7  | Done   | Consumer/UI/full validation and final review packet                      | Existing UI fixtures, module-updates.json          | T6         | implement.md commands and recorded evidence gaps |

## Execution Log

- 2026-11-09: Created planning task under root AGENTS.md; no product code changed. Existing user-owned untracked test.txt remains untouched.
- Google direct retrieval returned HTTP 401; user subsequently supplied protocol screenshots and explicitly required epay only. Screenshots establish signature, creation, GET notification and order query fields.
- Read-only POST-form query of a nonexistent order returned HTTP 200/application code 500; support is unverified. Secret remained in request body and was not printed. No charge, database access or deployment was performed.

- User approved implementation and subsequently selected documented GET query after clarification.
- User requested no further local verification and direct handoff for manual TEST-environment acceptance. Remaining test/build/UI runs were stopped; see verification.md. No commit, push, deployment, charge or remote database access.

## 2026-11-09 follow-up

- [x] Verify development callbacks reached the backend: six verify_failed events through 12:07 UTC; invalid_body, not a network-delivery failure. Logs do not preserve signed payloads or prove the rejected field.
- [x] Remove optional param from creation, required schemas and environment comparisons; preserve signed legacy extensions and trusted local-order settlement guards.
- [x] Extend existing regression files for both alipay/wxpay creation, missing/empty/legacy param, tampering and unknown orders.
- [x] Check WeChat availability: code already supports wxpay throughout recharge/VIP/gateway/recovery; development public plans currently reports wxpay_enabled=false.
- [x] User enabled WeChat manually in TEST. Rechecked public development plans: alipay_enabled=true, wxpay_enabled=true, default_payment_type=alipay. No production write or CLI repointing performed.
- [ ] After release, verify real paid-order recovery, WeChat handoff/return on Android and iOS, duplicate callbacks and late-paid recovery. Reuse the local @profile fixture flow for repeatable channel-selection coverage; provider payment and device handoff remain real-environment checks.

## Query pid compatibility fix (2026-11-09)

- [x] Reproduce the supplied query response: only pid=null fails shared validation; no sensitive response fixture is committed.
- [x] Accept omitted/null query pid; compare every non-null value and reject malformed input. Preserve request credentials, signed notification merchant checks, order/channel/reference/amount guards and atomic settlement.
- [x] Extend existing shared/gateway regressions for paid/unpaid null/missing pid and invalid identity fields; no new test file or dependency.
- [ ] Full local verification stopped at explicit user request. Shared tests, workspace typechecks, Admin build and source lint/format completed; backend rerun and frontend build interrupted. Details in verification.md.
- [ ] After reviewed release, verify both API polling and development reconciliation recover without response_invalid, plus wrong merchant/ref/amount rejection. No live payment or deployment is authorized by this local fix.
