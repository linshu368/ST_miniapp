-- Batch Lab postprocessing processor versions and display results.
-- domain: internal research tooling (batch_lab)
--
-- Execute manually through the Database Migration workflow, test first, one file at a time.
-- This migration does not touch source business schemas.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS batch_lab;

CREATE TABLE IF NOT EXISTS batch_lab.processor_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  protocol    TEXT NOT NULL CHECK (protocol IN ('none_v1', 'regex_json_v1')),
  config      JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  digest      TEXT NOT NULL UNIQUE CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_lab_processor_versions_created
  ON batch_lab.processor_versions (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS batch_lab.display_results (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_version_id  UUID NOT NULL REFERENCES batch_lab.processor_versions(id) ON DELETE RESTRICT,
  processor_digest      TEXT NOT NULL CHECK (processor_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_kind           TEXT NOT NULL DEFAULT 'preview' CHECK (source_kind IN ('preview', 'experiment_attempt')),
  source_id             UUID,
  idempotency_key       UUID UNIQUE,
  status                TEXT NOT NULL CHECK (status IN ('success', 'failed', 'timeout', 'limit_exceeded', 'validation_error')),
  error_code            TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
      'BATCH_LAB_PROCESSOR_TIMEOUT',
      'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED',
      'BATCH_LAB_PROCESSOR_RUNTIME_ERROR'
    )
  ),
  match_count           INTEGER NOT NULL CHECK (match_count >= 0),
  input_digest          TEXT NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  input_text            TEXT NOT NULL CHECK (char_length(input_text) <= 200000),
  output_text           TEXT NOT NULL CHECK (char_length(output_text) <= 200000),
  sanitized_html        TEXT NOT NULL CHECK (char_length(sanitized_html) <= 1200000),
  renderer_protocol     TEXT NOT NULL DEFAULT 'batch_lab_html_v1' CHECK (renderer_protocol = 'batch_lab_html_v1'),
  renderer_version      INTEGER NOT NULL DEFAULT 1 CHECK (renderer_version = 1),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT display_result_error_shape CHECK (
    (status = 'success' AND error_code IS NULL)
    OR (status <> 'success' AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_batch_lab_display_results_source
  ON batch_lab.display_results (source_kind, source_id, created_at DESC)
  WHERE source_id IS NOT NULL;

CREATE OR REPLACE FUNCTION batch_lab.prevent_processor_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'BATCH_LAB_PROCESSOR_VERSION_IMMUTABLE' USING ERRCODE = '45000';
END;
$$;

DROP TRIGGER IF EXISTS trg_batch_lab_processor_versions_no_update
  ON batch_lab.processor_versions;
CREATE TRIGGER trg_batch_lab_processor_versions_no_update
  BEFORE UPDATE OR DELETE ON batch_lab.processor_versions
  FOR EACH ROW EXECUTE FUNCTION batch_lab.prevent_processor_version_mutation();

CREATE OR REPLACE FUNCTION batch_lab.prevent_display_result_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'BATCH_LAB_DISPLAY_RESULT_IMMUTABLE' USING ERRCODE = '45000';
END;
$$;

DROP TRIGGER IF EXISTS trg_batch_lab_display_results_no_update
  ON batch_lab.display_results;
CREATE TRIGGER trg_batch_lab_display_results_no_update
  BEFORE UPDATE OR DELETE ON batch_lab.display_results
  FOR EACH ROW EXECUTE FUNCTION batch_lab.prevent_display_result_mutation();

INSERT INTO batch_lab.processor_versions (name, protocol, config, digest)
VALUES (
  'No postprocessing',
  'none_v1',
  '{"protocol":"none_v1"}'::jsonb,
  'sha256:8cdd3d1a3c9c48ddd94f48fcd60b303f9f3e295d6c3c15d436bb475459b33345'
)
ON CONFLICT (digest) DO NOTHING;

ALTER TABLE batch_lab.processor_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_lab.display_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE batch_lab.processor_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE batch_lab.display_results FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE batch_lab.processor_versions TO service_role, postgres;
GRANT SELECT, INSERT ON TABLE batch_lab.display_results TO service_role, postgres;

REVOKE ALL ON FUNCTION batch_lab.prevent_processor_version_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION batch_lab.prevent_display_result_mutation() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE batch_lab.processor_versions IS
  'Immutable Batch Lab postprocessor definitions. Edits create a new version.';
COMMENT ON TABLE batch_lab.display_results IS
  'Immutable sanitized postprocessing outputs. These results are display-only and never generation context.';
COMMENT ON FUNCTION batch_lab.prevent_processor_version_mutation() IS
  'Blocks UPDATE and DELETE so processor definitions remain immutable after creation.';
COMMENT ON FUNCTION batch_lab.prevent_display_result_mutation() IS
  'Blocks UPDATE and DELETE so display outputs remain immutable after creation.';

COMMIT;

-- Post-apply verification:
-- 1. SELECT protocol, digest FROM batch_lab.processor_versions ORDER BY created_at;
-- 2. SET ROLE anon; SELECT * FROM batch_lab.display_results; -- must be permission denied
-- 3. UPDATE batch_lab.processor_versions SET name = name; -- must raise immutable exception
-- 4. Rollback path: close the Batch Lab feature flag, then apply a reviewed forward-fix
--    migration to drop display_results, processor_versions and their trigger functions
--    only after confirming no consumer depends on them.
