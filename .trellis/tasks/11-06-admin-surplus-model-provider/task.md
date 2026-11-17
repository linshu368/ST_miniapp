# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                             | Files / Scope                   | Depends On | Verification                |
| --- | ------ | ------------------------------------------------ | ------------------------------- | ---------- | --------------------------- |
| T1  | Done   | Extend shared provider contract                  | shared models/tests             | -          | shared tests/typecheck      |
| T2  | Done   | Correct Surplus Intelligence runtime/directory   | backend platform                | T1         | focused backend tests       |
| T3  | Done   | Integrate generation, observability and recovery | backend generation/repositories | T1,T2      | generation/recovery tests   |
| T4  | Done   | Expose Surplus in Admin catalog                  | admin UI/state/tests            | T1,T2      | admin tests/typecheck       |
| T5  | Done   | Correct provider docs and module knowledge       | docs/Trellis                    | T1-T4      | docs diff/module check      |
| T6  | Done   | Run full affected validation and prepare review  | workspace                       | T1-T5      | commands in implement.md    |
| T7  | Done   | Correct balance monitor for Surplus Intelligence | backend/Railway                 | T2,T3      | focused monitor tests       |
| T8  | Done   | Re-run affected validation and update review     | workspace/docs                  | T7         | typecheck/lint/module check |

## Execution Log

- 2026-11-06: completed repository/spec research and planning gate; implementation not started.
- 2026-11-06: implemented the shared Surplus provider contract, backend runtime/directory/generation/recovery integration and registry-driven Admin loading.
- 2026-11-06: completed affected tests, typechecks, Admin build, lint/import/complexity checks and prepared the change for mandatory human review; no production catalog write or deployment was performed.
- 2026-11-06: user extended the task with Surplus balance alerting; researched the official balance endpoint and existing Venice/payment-alert-monitor integration, then reopened implementation validation.
- 2026-11-06: added the Surplus $10 P1 balance rule, bounded probe/retry, two-pass recovery, failure-isolated shared monitor round and Railway provider variable references; no Railway apply or production write was performed.
- 2026-11-06: balance-focused tests, complete Backend tests, Backend/IaC typechecks, focused ESLint, legacy guard and complexity checks passed; prepared for human review.
- 2026-11-06: user clarified the provider is Surplus Intelligence. Official contract review found the earlier SurplusLLM base URL and `/balance` schema were wrong; reopened runtime, directory, balance-monitor, documentation and validation work before review.
- 2026-11-06: corrected the canonical base, text-model filtering and `/payments/balance` microdollar parser; TLS-verified read-only probes and all affected non-integration tests/typechecks/build/lint/Trellis checks passed. Docker-only ranking integration remains unrun; no commit, Railway apply or production write was performed.
