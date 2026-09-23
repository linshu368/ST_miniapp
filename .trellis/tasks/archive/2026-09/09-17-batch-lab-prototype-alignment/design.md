# Design

## Inputs Read

- `D:\download\批量调试平台 · V1 工程需求说明\批量调试平台 · V1 工程需求说明.md`
- `D:\download\批量调试平台 · V1 工程需求说明\图片和附件\batch-lab-prototype.html`
- `.trellis/tasks/archive/2026-09/09-11-batch-lab-platform-planning/{prd.md,design.md,implement.md,task.md}`
- `.trellis/spec/frontend/app/index.md`
- `.trellis/spec/backend/app/index.md`
- `.trellis/spec/shared/contracts/index.md`
- `.trellis/spec/database/supabase/index.md`
- `.trellis/spec/backend/app/routes-and-features.md`
- `.trellis/spec/backend/app/data-reliability-and-security.md`
- `.trellis/spec/shared/contracts/api-contracts.md`

## Current Implementation Inventory

- Frontend package `packages/batch-lab` currently has one large `App.tsx`, `api/client.ts`, query keys, and workbench helpers.
- Existing pages cover navigation, experiment list, sample preview/save, processor edit/preview/save, and basic experiment creation.
- Existing shared contract `packages/shared/src/api/batch-lab.ts` covers context, SQL templates, preview, sample set list/create, processor versions, processor preview, experiment summary/detail/copy/reuse/start, annotation, JSONL export, and worker run-once.
- Existing backend route `packages/backend/src/routes/batch-lab.ts` exposes those contracts, but has no sample-set detail/delete, no result-detail endpoint, no output preset/provider config contract, and no direct result rows endpoint for UI comparison.
- Existing database tables support immutable sample snapshots, processor versions/display results, experiments, attempts, lineage, annotations, and JSONL export, but experiments lack purpose/output preset/provider-config columns and sample sets lack deletion/archival state.

## Prototype Gap Map

- Sample sets:
  - Prototype requires list actions, detail view, SQL display, sample table and context browsing.
  - Current UI only lists summary and creates from preview.
  - Current backend can export samples for JSONL internally but does not expose sample-set detail/pagination.
- Experiment records:
  - Prototype history has no start/worker controls.
  - Current UI has per-row start and page-level worker run-once.
  - Current detail drawer only shows summary, diff rows, copy/reuse/export and experiment-level note.
- Result comparison:
  - Prototype requires sample/round navigation, context, original/user input, A/B raw and rich display, annotations and export preview.
  - Current detail API returns no attempts, display results, samples or annotations.
- Postprocessing:
  - Prototype preview renders in phone-width chat bubble with hit count and styles.
  - Current preview renders sanitized HTML in a generic card. Save invalidates broad `['batch-lab']`, which is not a precise guarantee that the bottom list refreshes in all query-key states.
- New experiment:
  - Prototype includes optional purpose, output preset, provider config fields, rerun mode controls and confirm view.
  - Current form captures model_id/openrouter_model_id/tier/is_free/sampling/processor/max_turns only.

## Data Model and Migration Plan

Add one forward migration, tentatively `packages/shared/migrations/20260917_batch_lab_prototype_alignment.sql` or later date if implemented later.

Migration responsibilities:

- Add archival state to `batch_lab.sample_sets`:
  - `deleted_at timestamptz null`
  - optional `deleted_reason text null`
  - list queries exclude deleted by default.
  - deletion route should be soft-delete only. If an active or historical experiment references the set, soft-delete hides it from new selection but preserves history.
- Add prototype configuration fields to `batch_lab.experiments`:
  - `purpose text null`
  - `run_mode text not null default 'single' check in ('single','multi_turn')`
  - `output_preset jsonb not null default '{}'::jsonb`
  - `provider_config jsonb not null default '{}'::jsonb`
  - These fields are frozen at creation time and copied/reused with lineage.
- Consider preserving variant-local output preset if the prototype treats A and B preset independently. If both variants can differ, store it inside each variant snapshot rather than only on experiment. The design should prefer variant-local fields because the original 09-11 design describes A/B complete combination as model params + output preset + postprocessor.
- Do not store real API keys in `provider_config`. Store `key_ref`, `base_url`, `module_name`, and safe metadata only.

Rollback/forward-fix:

- Feature flag can disable Batch Lab endpoints before applying a corrective migration.
- Soft-delete fields are additive and can be ignored by old code.
- Experiment fields are additive defaults; old rows display empty purpose/output preset/provider config.

## Shared Contract Plan

Extend `packages/shared/src/api/batch-lab.ts` first:

- Sample set:
  - `BatchLabSampleSetDetail` includes frozen SQL, frozen parameters, statistics, source preview id/digest, created/deleted fields.
  - `BatchLabSampleSnapshotPage` includes items, pagination cursor, and sample metadata matching preview item schema.
  - `BatchLabDeleteSampleSetRequest/Response`.
- Experiment:
  - Extend summary/detail with `purpose`, `run_mode`, `output_preset`, provider config summary, lineage and sample set summary.
  - Extend variant schema to include `provider_base_url`, `provider_key_ref`, `module_name`, sampling/output limits and optional output preset snapshot, or define a new `BatchLabExperimentVariantV2` and migration adapter.
  - Add `BatchLabExperimentResultDetail` for UI comparison: experiment, sample set, samples page or selected sample, attempts grouped by sample/variant/turn, display results, annotations, progress/failure summary.
  - Add endpoint schemas for result detail and sample-set detail/page.
- Postprocessing:
  - Keep sanitized HTML and renderer fields.
  - Add preview metadata if needed by UI: `match_count` is already present; preserve `status/error_code`.

## Backend Plan

- `BatchLabSampleRepository`
  - Add `getSampleSetDetail`, `listSampleSnapshots`, `softDeleteSampleSet`.
  - Delete route must verify source environment and preserve referenced history.
- `BatchLabExecutionRepository`
  - Add `getExperimentResultDetail` with bounded query sizes and cursor/page parameters.
  - Join or separately fetch `sample_snapshots`, `experiment_attempts`, `display_results`, annotations, and lineage.
  - Add create/copy/reuse support for purpose, run mode, output preset and provider config.
  - For reuse-display, materialize display results from existing raw outputs and new processors without new generation attempts, or expose enough detail to compute stored display rows via backend service.
- `BatchLabExecutionService`
  - Update generation call to use provider config snapshot safely.
  - Continue routing all generation through `features/generation`.
  - Ensure postprocessing output never enters next-turn context.
- Routes:
  - Add `GET /api/batch-lab/sample-sets/:id`
  - Add `GET /api/batch-lab/sample-sets/:id/samples`
  - Add `DELETE /api/batch-lab/sample-sets/:id`
  - Add `GET /api/batch-lab/experiments/:id/results`
  - Update create/copy/reuse schemas.
  - Remove or keep internal worker endpoint as `@frontend-ready: false`; frontend must not surface it in history.

## Frontend Plan

Keep the current package and Ant Design stack unless a local design system is introduced by existing code. Refactor `App.tsx` into feature sections only if needed to keep changes reviewable.

- Samples page:
  - Add min-turn input and bind it into template parameters and SQL.
  - Add sample set list actions: view samples, delete/restore state if implemented, use for experiment.
  - Add detail drawer/page matching prototype: SQL, stats, sample table, context collapse.
- Experiments page:
  - Remove start and worker controls from history.
  - Rename action to “查看对比” and open the complete result detail.
  - Add history columns for type, sample set, mode, status, time/source.
- Result detail:
  - Implement sample navigation, round navigation, context panel, A/B columns, raw/rich toggle, annotations, export, copy, reuse original.
  - Rich view must consume backend sanitized display results.
- Processors page:
  - Use phone-width preview container and prototype copy/layout.
  - Save success invalidates exact processor query key and resets/keeps form state intentionally.
  - Bottom version list refreshes immediately.
- New experiment:
  - Add purpose, output preset fields, model provider URL/key ref/module name fields, mode controls and confirm page.
  - Remove modal that asks whether to start after draft creation if prototype expects creation+run confirmation in one flow; otherwise ensure “start” remains confined to new experiment flow.

## Reliability and Security

- Timeouts:
  - Keep existing client timeouts for preview/postprocessor/worker; result detail should be paginated and bounded.
- Retries:
  - Preserve existing finite attempt retry behavior in worker.
  - Delete and create operations remain idempotent where applicable.
- Concurrency:
  - Sample soft-delete must not race with experiment creation; backend should validate sample set availability at experiment creation.
  - Experiment start remains database-serialized by existing function.
- Data minimization:
  - Do not log full SQL, source rows, raw outputs, API keys or prompt bodies.
  - UI displays source data only in the internal Batch Lab app.
- RLS/grants:
  - New tables/columns inherit `batch_lab` service-role-only access; any new functions revoke public/anon/authenticated.
- Capacity:
  - Result detail page must paginate sample rows and avoid returning all raw outputs for large sets unless explicitly exporting.

## Verification Plan

- Shared:
  - `pnpm --filter @miniapp/shared test`
  - `pnpm --filter @miniapp/shared typecheck`
- Backend:
  - `pnpm --filter @miniapp/backend test -- batch-lab`
  - `pnpm --filter @miniapp/backend typecheck`
  - Manual source visibility and RLS/grant checks after migration in test.
- Batch Lab frontend:
  - `pnpm --filter @miniapp/batch-lab test`
  - `pnpm --filter @miniapp/batch-lab typecheck`
  - `pnpm --filter @miniapp/batch-lab build`
  - Manual browser pass against prototype checklist: samples, new experiment, history compare, processors, reuse original.

## Open Clarifications

- The user asks for model config fields `url/key/模块名`. Because project rules prohibit browser-side secrets, implementation should treat `key` as a backend secret reference unless the user explicitly changes the security model and project rules are updated.
- Confirm whether output preset is one shared experiment-level preset or variant-local A/B preset. The original V1 wording says A/B complete combination includes output preset, so variant-local is the safer default.
