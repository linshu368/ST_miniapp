# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                           | Files / Scope                                                                    | Depends On        | Verification                                                |
| --- | ------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| T1  | Todo   | Shared provider-neutral catalog schema and provider config     | `packages/shared/src/api/models.ts`, possible `model-providers.ts`, shared tests | Planning approval | shared typecheck/test                                       |
| T2  | Todo   | DB validation migration for multi-provider `llm_model_catalog` | `packages/shared/migrations/YYYYMMDD_llm_model_provider_catalog.sql`             | T1                | SQL review + test DB single-file migration validation       |
| T3  | Todo   | Backend provider directory route and Venice directory adapter  | `packages/backend/src/platform/*models*.ts`, `routes/models.ts`                  | T1                | backend typecheck/test; mocked adapter tests                |
| T4  | Todo   | Backend generation provider routing for OpenRouter/Venice      | `features/generation/*`, `platform/model-tiers.ts`, config/env docs              | T1, T2            | backend generation tests; manual SSE smoke                  |
| T5  | Todo   | Admin provider directory helper/config and editor UI           | `ModelCatalogEditor.tsx`, `src/lib/*model*`, diff/schema/tests                   | T1, T3            | admin typecheck/test/build; manual Admin smoke              |
| T6  | Todo   | Docs, env and Railway rollout notes                            | `README.md`, `ops/railway/README.md`, env examples as applicable                 | T4                | doc review; no secrets committed                            |
| T7  | Todo   | Full cross-layer validation and release checklist              | all affected packages                                                            | T1-T6             | `pnpm -r typecheck`, package tests/builds, manual scenarios |

## Execution Log

- 2026-09-29: Created planning task from user request.
- 2026-09-29: Researched current OpenRouter-only catalog chain, Venice official API docs, shared/backend/Admin specs, and DB validation constraints.
- 2026-09-29: Wrote PRD, design, implementation plan, research notes, and context manifests. Task remains in `planning`; no product code changed.
