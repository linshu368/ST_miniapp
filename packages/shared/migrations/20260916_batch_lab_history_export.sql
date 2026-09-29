-- Batch Lab history lineage, annotations and export support.
-- domain: internal research tooling (batch_lab)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS batch_lab;

ALTER TABLE batch_lab.experiments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generation'
    CHECK (kind IN ('generation', 'reuse_display')),
  ADD COLUMN IF NOT EXISTS source_experiment_id UUID
    REFERENCES batch_lab.experiments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS generation_source_experiment_id UUID
    REFERENCES batch_lab.experiments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_batch_lab_experiments_lineage
  ON batch_lab.experiments (source_experiment_id, generation_source_experiment_id)
  WHERE source_experiment_id IS NOT NULL OR generation_source_experiment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS batch_lab.annotations (
  experiment_id  UUID NOT NULL REFERENCES batch_lab.experiments(id) ON DELETE RESTRICT,
  sample_ordinal INTEGER CHECK (sample_ordinal IS NULL OR sample_ordinal >= 0),
  turn_index     INTEGER CHECK (turn_index IS NULL OR turn_index BETWEEN 1 AND 5),
  tag            TEXT CHECK (tag IS NULL OR char_length(tag) <= 80),
  note           TEXT CHECK (note IS NULL OR char_length(note) <= 4000),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_lab_annotations_target
  ON batch_lab.annotations (
    experiment_id,
    COALESCE(sample_ordinal, -1),
    COALESCE(turn_index, -1)
  );

ALTER TABLE batch_lab.annotations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE batch_lab.annotations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE batch_lab.annotations TO service_role, postgres;

COMMENT ON COLUMN batch_lab.experiments.kind IS
  'generation experiments have model attempts; reuse_display experiments preserve raw outputs from a source experiment and only change display processors.';
COMMENT ON COLUMN batch_lab.experiments.source_experiment_id IS
  'Direct parent for copied or reuse experiments.';
COMMENT ON COLUMN batch_lab.experiments.generation_source_experiment_id IS
  'Original experiment whose model raw outputs are authoritative for reuse display experiments.';
COMMENT ON TABLE batch_lab.annotations IS
  'Lightweight human notes/tags for an experiment, optional sample and optional turn.';

COMMIT;

-- Post-apply verification:
-- 1. SELECT kind, source_experiment_id, generation_source_experiment_id FROM batch_lab.experiments LIMIT 1;
-- 2. SET ROLE anon; SELECT * FROM batch_lab.annotations; -- must be permission denied
-- 3. Upsert annotation for (experiment, null, null), then re-upsert and confirm one row.
-- 4. Rollback/forward-fix: close Batch Lab history/export endpoints, then drop annotations and lineage
--    columns only after preserving any needed audit/export evidence.
