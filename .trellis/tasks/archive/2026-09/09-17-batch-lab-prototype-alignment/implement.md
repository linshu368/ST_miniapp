# Implementation Plan

## Phase 0: Planning Gate

- [x] Read Trellis workflow and relevant specs.
- [x] Read archived 09-11 Batch Lab planning task.
- [x] Read provided PRD/prototype and current implementation inventory.
- [ ] Human review of this task's PRD/design/implementation plan.
- [ ] Run `task.py start` only after review approval.

## Phase 1: Contracts

- Update `packages/shared/src/api/batch-lab.ts` with sample detail/page/delete, experiment purpose/run mode/output preset/provider config, result detail, and extended reuse/copy schemas.
- Add or update shared tests for parsing and backwards compatibility.
- Ensure old rows without additive fields remain parseable through defaults or backend adapters.

## Phase 2: Database

- Add a forward migration under `packages/shared/migrations/`.
- Add soft-delete fields for sample sets.
- Add frozen experiment metadata fields for purpose, run mode, output preset and provider config.
- Add indexes needed by sample/result detail reads.
- Document post-apply verification and rollback/forward-fix in the migration footer.

## Phase 3: Backend

- Extend sample repository and routes:
  - list excludes soft-deleted by default.
  - get detail returns frozen SQL/params/statistics.
  - list samples returns bounded pages.
  - delete soft-deletes safely and remains compatible with historical experiments.
- Extend execution repository/service and routes:
  - create/copy/reuse preserve purpose, run mode, output preset and provider config snapshots.
  - result detail endpoint returns bounded grouped samples/attempts/display results/annotations.
  - reuse original recomputes/stores display results without generation calls.
- Ensure all route comments have `@frontend-ready`.
- Add or update backend tests around repository/service behavior, especially soft delete, result detail, and no-generation reuse.

## Phase 4: Frontend

- Refactor `App.tsx` if necessary into page components while preserving existing app entry.
- Samples:
  - add min-turn condition.
  - implement view sample drawer/page.
  - implement delete/archival action and refresh.
- Experiments:
  - remove start and worker controls from history.
  - implement complete compare detail view.
  - implement raw/rich toggle, sample/round navigation, notes, export, copy, reuse original.
- Processors:
  - render phone-width rich preview.
  - show status/hit count/error fallback.
  - refresh exact processor list after save.
- New experiment:
  - add optional purpose.
  - replace/reshape model fields to URL, key reference, module name.
  - add output preset section and confirm page content from prototype.
  - ensure start/run action exists only in the prototype new-experiment flow.

## Phase 5: Verification and Documentation

- Run shared/backend/batch-lab typecheck and tests.
- Run batch-lab build.
- Manually verify the prototype checklist in browser against a test backend.
- Update README/spec docs if deployment/env/API behavior changes.
- Record migration test evidence: shape, grants/RLS, key reads, rollback/forward-fix.

## Risks

- Result detail can become large; implement pagination and avoid eager all-row payloads.
- Secret handling conflicts with literal "key" field; use `key_ref` and backend-only secret resolution.
- Existing experiments created before new fields need safe defaults in backend mapping.
- Soft-deleting sample sets must not invalidate historical experiments or export.
