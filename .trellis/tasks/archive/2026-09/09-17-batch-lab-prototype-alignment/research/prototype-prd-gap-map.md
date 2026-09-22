# Prototype and PRD Gap Map

## Authoritative Inputs

- PRD: `D:\download\批量调试平台 · V1 工程需求说明\批量调试平台 · V1 工程需求说明.md`
- Prototype: `D:\download\批量调试平台 · V1 工程需求说明\图片和附件\batch-lab-prototype.html`
- Archived umbrella plan: `.trellis/tasks/archive/2026-09/09-11-batch-lab-platform-planning`

## Required Prototype Elements

- Navigation: 实验记录, 样本集, 富文本后处理, 新建实验.
- Samples:
  - SQL template editor.
  - 当前轮次至少.
  - 抽取条数.
  - 样本集名称.
  - Preview statistics and sample rows.
  - View frozen SQL and sample context.
- Experiment history:
  - No start button in history list.
  - Action is view/查看对比.
  - Detail includes diff, progress, sample/round browsing, context, raw/rich display, annotations, export and reuse original.
- New experiment:
  - 本次想验证什么 · 选填.
  - A/B configuration.
  - Output preset / prescribed content and format.
  - Rerun mode single/multi-turn and planned calls.
  - Confirmation page with scale and diff.
- Postprocessing:
  - Copy existing version.
  - Edit rule JSON.
  - Preview input.
  - Rich rendered phone-width preview with hit count/status.
  - Save immutable new version and refresh saved version list.
- Export:
  - JSONL preserves schema/version, source/generation lineage, sample anchor/window, variants, raw outputs, display results, annotations and errors.

## Current Gaps

- Sample set list lacks view samples and delete/archival action.
- Sample creation UI lacks a first-class min-turn field even though default SQL filters `turn_index >= 1`.
- Experiment history exposes start and worker controls that prototype does not include.
- Experiment detail drawer is summary-only and does not implement full compare browsing.
- Processor preview uses generic rich HTML card, not phone-width message preview.
- Processor save invalidation is broad and should refresh exact list.
- New experiment lacks purpose and output preset fields.
- Current model fields are model_id/openrouter_model_id/tier/is_free/sampling, not the requested URL/key/module-name shape.
- Shared contracts/backend lack result-detail and sample-detail endpoints needed by the prototype.

## Security Reconciliation

The user requested `key` as a model config field. Project rules prohibit exposing or storing secrets in browser-side code, Markdown, logs, URL or fixtures. Treat the visible field as a `key_ref`/secret alias unless the project security model is explicitly changed.
