# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                                               | Files / Scope                                                                      | Depends On | Verification                                                       |
| --- | ------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| T0  | Done    | Read workflow/spec/prototype/archive/current code                                                  | Trellis specs, provided PRD/prototype, archived 09-11 task, current Batch Lab code | -          | Planning notes captured in research/design                         |
| T1  | Blocked | Human review and approval to start implementation                                                  | This task's `prd.md`, `design.md`, `implement.md`, `task.md`                       | T0         | Explicit approval before `task.py start`                           |
| T2  | Todo    | Extend shared contracts for sample details, deletion, experiment metadata, result detail and reuse | `packages/shared/src/api/batch-lab.ts`, exports/tests                              | T1         | Shared tests/typecheck                                             |
| T3  | Todo    | Add Batch Lab alignment migration                                                                  | `packages/shared/migrations/*batch_lab*prototype*alignment*.sql`                   | T2         | Test DB shape, grants/RLS, rollback notes                          |
| T4  | Todo    | Implement sample-set detail, paged samples and soft delete backend                                 | Backend repository/service/routes/tests                                            | T2,T3      | Backend tests, manual sample detail/delete                         |
| T5  | Todo    | Implement experiment metadata, result-detail API and no-generation reuse display                   | Backend execution repository/service/routes/tests                                  | T2,T3      | Backend tests, manual detail/reuse flow                            |
| T6  | Todo    | Update frontend API client/query keys                                                              | `packages/batch-lab/src/api/*`                                                     | T2,T4,T5   | Client tests/typecheck                                             |
| T7  | Todo    | Rebuild samples page to match prototype                                                            | `packages/batch-lab/src/*`                                                         | T6         | Manual sample preview/save/view/delete                             |
| T8  | Todo    | Rebuild experiment history and compare detail to match prototype                                   | `packages/batch-lab/src/*`                                                         | T6         | Manual history/view compare/export/reuse                           |
| T9  | Todo    | Rebuild postprocessing preview and version refresh                                                 | `packages/batch-lab/src/*`                                                         | T6         | Manual rich preview and save-refresh                               |
| T10 | Todo    | Rebuild new experiment flow fields and confirmation                                                | `packages/batch-lab/src/*`                                                         | T6         | Manual create/run confirmation with purpose/preset/provider fields |
| T11 | Todo    | Run verification matrix and update docs if needed                                                  | shared/backend/batch-lab/docs                                                      | T7-T10     | Tests/typecheck/build/manual checklist                             |

## Execution Log

- 2026-09-17: Created planning task after user requested full prototype alignment repair. Implementation is intentionally blocked until planning review/start.
