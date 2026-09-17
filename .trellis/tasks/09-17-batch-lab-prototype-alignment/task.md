# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                                               | Files / Scope                                                                      | Depends On | Verification                                                                                                                                                        |
| --- | ------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | Done   | Read workflow/spec/prototype/archive/current code                                                  | Trellis specs, provided PRD/prototype, archived 09-11 task, current Batch Lab code | -          | Planning notes captured in research/design                                                                                                                          |
| T1  | Done   | Human review and approval to start implementation                                                  | This task's `prd.md`, `design.md`, `implement.md`, `task.md`                       | T0         | User approved start; `task.py start` succeeded                                                                                                                      |
| T2  | Done   | Extend shared contracts for sample details, deletion, experiment metadata, result detail and reuse | `packages/shared/src/api/batch-lab.ts`, exports/tests                              | T1         | Shared tests/typecheck passed                                                                                                                                       |
| T3  | Done   | Add Batch Lab alignment migration                                                                  | `packages/shared/migrations/20260917_batch_lab_prototype_alignment.sql`            | T2         | Migration includes shape checks, grants/RLS assumptions and rollback notes; DB manual apply still pending                                                           |
| T4  | Done   | Implement sample-set detail, paged samples and soft delete backend                                 | Backend repository/service/routes/tests                                            | T2,T3      | Backend Batch Lab tests/typecheck passed                                                                                                                            |
| T5  | Done   | Implement experiment metadata, result-detail API and no-generation reuse display                   | Backend execution repository/service/routes/tests                                  | T2,T3      | Result-detail API implemented; backend Batch Lab tests/typecheck passed                                                                                             |
| T6  | Done   | Update frontend API client/query keys                                                              | `packages/batch-lab/src/api/*`                                                     | T2,T4,T5   | Batch Lab tests/typecheck passed                                                                                                                                    |
| T7  | Done   | Rebuild samples page to match prototype                                                            | `packages/batch-lab/src/*`                                                         | T6         | Form has min turn; list has view/delete; typecheck/build passed; browser pass pending                                                                               |
| T8  | Done   | Rebuild experiment history and compare detail to match prototype                                   | `packages/batch-lab/src/*`                                                         | T6         | History start/worker controls removed; compare detail has sample/turn/raw-rich; typecheck/build passed; browser pass pending                                        |
| T9  | Done   | Rebuild postprocessing preview and version refresh                                                 | `packages/batch-lab/src/*`, backend renderer                                       | T6         | Phone-message status/memory rendering and exact processor refresh implemented; backend/batch-lab tests/typecheck/build passed; browser pass pending                 |
| T10 | Done   | Rebuild new experiment flow fields and confirmation                                                | `packages/batch-lab/src/*`, backend generation override                            | T6         | Purpose plus per-combination OpenRouter URL/model/output preset/postprocessor implemented; Batch Lab uses server-side `BATCH_LAB_MODEL_KEY`; typecheck/build passed |
| T11 | Doing  | Run verification matrix and update docs if needed                                                  | shared/backend/batch-lab/docs                                                      | T7-T10     | Automated tests/typecheck/build passed; manual DB migration/browser checklist pending                                                                               |

## Execution Log

- 2026-09-17: Created planning task after user requested full prototype alignment repair. Implementation was blocked until planning review/start.
- 2026-09-17: User approved start. `task.py start 09-17-batch-lab-prototype-alignment` succeeded after declaring module impact.
- 2026-09-17: Implemented shared API extensions, additive migration, backend sample/result endpoints, Batch Lab client/query keys, and frontend prototype-alignment fixes for samples, history compare, postprocessing preview, and new experiment fields.
- 2026-09-17: Automated verification passed:
  - `pnpm --filter @miniapp/shared test -- batch-lab-contract`
  - `pnpm --filter @miniapp/shared typecheck`
  - `pnpm --filter @miniapp/backend typecheck`
  - `pnpm --filter @miniapp/backend test -- batch-lab`
  - `pnpm --filter @miniapp/batch-lab test`
  - `pnpm --filter @miniapp/batch-lab typecheck`
  - `pnpm --filter @miniapp/batch-lab build`
- 2026-09-17: Follow-up fixes after user review:
  - New experiment A/B cards now own OpenRouter URL, model name, output preset and paired postprocessor; removed visible tier/free-model/sampling/global provider fields.
  - Batch Lab generation calls now use per-variant OpenRouter URL/model and server env `BATCH_LAB_MODEL_KEY`; output presets are injected into the internal generation messages.
  - Rich-text postprocessing now renders `[status]...[/status]` and `[memory]...[/memory]` into phone-message safe HTML blocks matching the prototype preview.
  - Experiment and sample-set read paths now fall back to legacy selects when the additive migration has not yet reached the target database, preventing `/batch-lab/experiments` from showing only "temporarily unavailable" for old schemas.
- 2026-09-17: Follow-up automated verification passed:
  - `pnpm --filter @miniapp/shared test -- batch-lab-contract`
  - `pnpm --filter @miniapp/shared typecheck`
  - `pnpm --filter @miniapp/backend typecheck`
  - `pnpm --filter @miniapp/backend test -- batch-lab`
  - `pnpm --filter @miniapp/batch-lab test`
  - `pnpm --filter @miniapp/batch-lab typecheck`
  - `pnpm --filter @miniapp/batch-lab build`
- 2026-09-17: Remaining manual work before archive/commit: apply `20260917_batch_lab_prototype_alignment.sql` to test, refresh PostgREST schema if needed, perform browser walkthrough against the prototype checklist, and prepare module knowledge update if required by archive gate.
- 2026-09-17: Fixed experiment-list 503 caused by additive migration rows storing `{}` for `output_preset` and `provider_config`: repository mapping now normalizes partial/empty stored metadata to complete API contract defaults, with a regression test. The list route now logs the original error as `{ err }`. Backend Batch Lab tests (95), backend typecheck, direct repository query, and `GET /api/batch-lab/experiments` (HTTP 200, two rows) passed.
- 2026-09-17: User superseded the earlier history-action requirement and requested controls in the experiment record operation column. Added draft start, cooperative stop, soft delete, and bounded-batch “execute all” controls with shared contracts, backend routes/repository methods, migration, and client coverage. Migration `20260917_batch_lab_experiment_controls.sql` still requires manual test-environment apply before browser verification.
- 2026-09-17: Follow-up retained the single-attempt execute button, capped execute-all batches at 10 attempts, and extended the targeted run-once client timeout to cover a bounded serial generation batch.
