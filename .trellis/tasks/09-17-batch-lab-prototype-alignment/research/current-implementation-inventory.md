# Current Implementation Inventory

## Frontend

- `packages/batch-lab/src/App.tsx`
  - Single file currently implements shell, experiment list/detail drawer, samples page, preview panel, processors page, and new experiment wizard.
  - Experiment list has per-row start and page-level worker run-once.
  - Samples page can preview and freeze a sample set, but does not inspect or delete saved sets.
  - Processor page can preview and save versions, but preview is a generic card.
  - New experiment wizard creates a draft and prompts to start in a modal.
- `packages/batch-lab/src/api/client.ts`
  - Covers existing routes only: context, templates, processors, sample previews, sample sets list/create, experiments list/create/detail/copy/reuse/start, annotation, export, worker.
- `packages/batch-lab/src/lib/workbench.ts`
  - Parses SQL params, sampling JSON and regex rules.
  - Diff rows cover model_id/openrouter_model_id/tier/is_free/sampling/processor/max_turns.
- `packages/batch-lab/src/styles.css`
  - Basic Ant layout styles and `.rich-preview`, but not prototype-like phone message layout.

## Shared Contracts

- `packages/shared/src/api/batch-lab.ts`
  - No sample-set detail schema.
  - No sample snapshot page schema.
  - No delete/soft-delete schema.
  - Experiment detail extends summary only with lineage.
  - No result-detail schema for compare view.
  - No purpose/output preset/provider config fields.

## Backend Routes

- `packages/backend/src/routes/batch-lab.ts`
  - Exposes current skeleton routes.
  - Missing sample-set detail, sample pagination and delete.
  - Missing experiment result detail.
  - Worker route is internal but currently consumed by frontend.

## Backend Repositories and Services

- `BatchLabSampleRepository`
  - Has `listTemplates`, `createPreview`, `freezeSampleSet`, `listSampleSets`.
  - Missing `getSampleSetDetail`, `listSampleSnapshots`, `softDeleteSampleSet`.
- `BatchLabExecutionRepository`
  - Can create/start/list/get/copy/reuse experiments, annotate, claim attempts, export rows.
  - Detail API returns summary+lineage only.
  - Export can read samples and attempts, which can be reused for result detail design.
- `BatchLabProcessorRepository`
  - Can list/get/create processor versions and create display results.
  - No issue with immutable storage, but frontend list refresh must be exact.

## Database

- `110_batch_lab_samples.sql`
  - Defines templates, previews, sample sets, sample snapshots and freeze function.
  - No deleted/archived fields.
- `20260916_batch_lab_postprocessing.sql`
  - Defines immutable processor versions and display results.
- `20260916_batch_lab_execution.sql`
  - Defines experiments and experiment attempts.
  - No purpose/output preset/provider config fields.
- `20260916_batch_lab_history_export.sql`
  - Adds lineage and annotations.
- `20260917_batch_lab_source_rls_policies.sql`
  - Adds source RLS policies for joined source rows.

## Reuse Opportunities

- Reuse existing preview item schema for sample detail items.
- Reuse export row query logic as the basis for result detail, but expose bounded/paginated interactive payloads instead of downloading JSONL.
- Reuse postprocessing service for preview and reuse-display recomputation.
- Reuse existing worker/retry state machine for generation; do not introduce a new runner.
