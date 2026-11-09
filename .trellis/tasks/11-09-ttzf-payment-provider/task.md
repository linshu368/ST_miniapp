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
| T2  | Todo   | Human planning review, old-order/query recovery decisions and task start | PRD/design/implement/task.json                     | T1         | Reviewed plan and in_progress status             |
| T3  | Todo   | Epay gateway/signatures/shared external callback schema                  | infrastructure/payment, shared/api/payment         | T2         | Protocol/security regressions                    |
| T4  | Todo   | Creation, notification, polling/return, exact settlement                 | routes/payment, RechargeUseCase, PaymentSettlement | T3         | Existing and reviewed failure-path tests         |
| T5  | Todo   | Fair bounded reconciliation and history isolation                        | reconciliation, repository, payment scripts        | T4         | Slow/partial/duplicate/legacy cases              |
| T6  | Todo   | Config/deployment references/diagnostics/docs                            | config, Railway/PR workflow, README/spec/ops       | T5         | Build/static checks and configuration review     |
| T7  | Todo   | Consumer/UI/full validation and final review packet                      | Existing UI fixtures, module-updates.json          | T6         | implement.md commands and recorded evidence gaps |

## Execution Log

- 2026-11-09: Created planning task under root AGENTS.md; no product code changed. Existing user-owned untracked test.txt remains untouched.
- Google direct retrieval returned HTTP 401; user subsequently supplied protocol screenshots and explicitly required epay only. Screenshots establish signature, creation, GET notification and order query fields.
- Read-only POST-form query of a nonexistent order returned HTTP 200/application code 500; support is unverified. Secret remained in request body and was not printed. No charge, database access or deployment was performed.
