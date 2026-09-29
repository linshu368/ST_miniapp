# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                           | Files / Scope                                                              | Depends On        | Verification                                          |
| --- | ------ | -------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| T1  | Done   | Shared provider-neutral catalog schema and provider config     | `packages/shared/src/api/models.ts`, shared tests                          | Planning approval | shared typecheck/test                                 |
| T2  | Doing  | DB validation migration for multi-provider `llm_model_catalog` | `packages/shared/migrations/20260929_llm_model_catalog_multi_provider.sql` | T1                | Code committed; TEST apply/evidence still required    |
| T3  | Done   | Backend provider directory route and Venice directory adapter  | `packages/backend/src/platform/*models*.ts`, `routes/models.ts`            | T1                | backend typecheck/test                                |
| T4  | Done   | Backend generation provider routing for OpenRouter/Venice      | `features/generation/*`, `platform/model-tiers.ts`, config/env docs        | T1, T2            | backend generation tests                              |
| T5  | Doing  | Admin provider directory helper/config and editor UI           | `ModelCatalogEditor.tsx`, `src/lib/*model*`, diff/schema/tests             | T1, T3            | Implemented; manual smoke and focused UI tests remain |
| T6  | Done   | Docs, env and Railway rollout notes                            | `ops/railway/README.md`, backend env examples                              | T4                | doc review; no secrets committed                      |
| T7  | Doing  | Full cross-layer validation and release checklist              | all affected packages                                                      | T1-T6             | automated checks pass; TEST/manual scenarios remain   |
| T8  | Doing  | Venice 独立 provider history 与 usage/价格解析                 | `experience.venice_chat_history`, generation parser/repository             | T2, T4            | Code/tests done; TEST migration + real provider smoke |

## Execution Log

- 2026-09-29: Created planning task from user request.
- 2026-09-29: Researched current OpenRouter-only catalog chain, Venice official API docs, shared/backend/Admin specs, and DB validation constraints.
- 2026-09-29: Wrote PRD, design, implementation plan, research notes, and context manifests. Task remains in `planning`; no product code changed.
- 2026-09-29: Started implementation and completed the shared contract, provider-aware Admin/backend paths, Venice directory/generation routing, billing metadata handling, env/docs, and the DB migration draft.
- 2026-09-29: Automated verification passed: shared 100 tests, Admin 55 tests/build, backend 531 tests, affected package typechecks, root lint, migration filename check, and `git diff --check` (line-ending warnings only).
- 2026-09-29: Remaining release gates are intentionally manual: execute the migration against TEST with pre/post shape and rollback capture, then run Admin directory sync and real OpenRouter/Venice SSE smoke scenarios. No production migration or external API smoke was performed in this session.
- 2026-09-29: Scope expanded by user: main turns remain in `experience.chat_history`, while Venice provider responses/usages move to a dedicated one-to-one `experience.venice_chat_history` table with OpenRouter-equivalent metadata fields. Planning gate updated before implementation.
- 2026-09-29: Implemented and committed the Venice provider history/usage follow-up (`93e42dc`): stream/non-stream response capture, token/cost mapping, dedicated repository/migration, settlement isolation, tests, architecture docs, and legacy-guard compatibility.
- 2026-09-29: Reassessed completion after implementation. Code and automated verification are substantially complete (~90%), but the task remains `in_progress` because neither migration has TEST execution evidence and real Admin/provider smoke scenarios are still outstanding. Focused gaps also remain for directory adapter failures, Admin provider switching/cross-provider IDs, Venice non-stream and usage-missing regression.

## Remaining Release Gates

1. TEST apply and evidence for `20260929_llm_model_catalog_multi_provider.sql`.
2. TEST apply and evidence for `20260929_venice_chat_history.sql` (shape/FK/unique/grants/cascade/upsert/rollback).
3. Real Admin OpenRouter + Venice directory sync, edit, publish and legacy OpenRouter compatibility smoke.
4. Real Venice streaming + non-streaming generation and failure-path smoke; verify provider table data and no Venice metadata pollution in `chat_history`.
5. Record logs/security review and either add focused missing tests or explicitly accept documented residual risks.
