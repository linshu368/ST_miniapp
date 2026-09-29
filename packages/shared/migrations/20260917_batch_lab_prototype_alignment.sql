-- 20260917: Batch Lab prototype-alignment metadata and safe sample-set archival.
-- domain: batch_lab
--
-- Adds only forward-compatible metadata needed by the V1 prototype UI. This migration does
-- not write source business schemas and does not store provider secrets.
--
-- Rollback / forward-fix:
--   1. Disable Batch Lab endpoints with the feature flag.
--   2. If no consumer has used the new fields, apply a reviewed migration that drops:
--        batch_lab.sample_sets.deleted_at
--        batch_lab.sample_sets.deleted_reason
--        batch_lab.experiments.purpose
--        batch_lab.experiments.run_mode
--        batch_lab.experiments.output_preset
--        batch_lab.experiments.provider_config
--      and restores the previous create_experiment signature.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('batch_lab.sample_sets') IS NULL THEN
    RAISE EXCEPTION 'batch_lab.sample_sets is missing; run 20260920_batch_lab_samples.sql first';
  END IF;
  IF to_regclass('batch_lab.experiments') IS NULL THEN
    RAISE EXCEPTION 'batch_lab.experiments is missing; run 20260916_batch_lab_execution.sql first';
  END IF;
END;
$$;

ALTER TABLE batch_lab.sample_sets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT CHECK (
    deleted_reason IS NULL OR char_length(deleted_reason) <= 500
  );

CREATE INDEX IF NOT EXISTS idx_batch_lab_sample_sets_active_created
  ON batch_lab.sample_sets (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE batch_lab.experiments
  ADD COLUMN IF NOT EXISTS purpose TEXT CHECK (
    purpose IS NULL OR char_length(purpose) <= 2000
  ),
  ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'single'
    CHECK (run_mode IN ('single', 'multi_turn')),
  ADD COLUMN IF NOT EXISTS output_preset JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(output_preset) = 'object'),
  ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(provider_config) = 'object');

COMMENT ON COLUMN batch_lab.sample_sets.deleted_at IS
  'Soft archival timestamp. Archived sample sets are hidden from new experiment selection but retained for historical experiments and exports.';
COMMENT ON COLUMN batch_lab.sample_sets.deleted_reason IS
  'Optional internal archival reason. Never store source rows or sensitive content here.';
COMMENT ON COLUMN batch_lab.experiments.purpose IS
  'Optional human-written experiment purpose frozen at creation/copy/reuse time.';
COMMENT ON COLUMN batch_lab.experiments.run_mode IS
  'Prototype run mode: single or multi_turn. Attempt rows remain the durable execution plan.';
COMMENT ON COLUMN batch_lab.experiments.output_preset IS
  'Frozen output preset metadata such as required content and format. Does not contain provider secrets.';
COMMENT ON COLUMN batch_lab.experiments.provider_config IS
  'Frozen provider metadata such as base_url, key_ref and module_name. key_ref is a secret reference, not the secret value.';

CREATE OR REPLACE FUNCTION batch_lab.create_experiment(
  p_name TEXT,
  p_sample_set_id UUID,
  p_source_environment TEXT,
  p_variants JSONB,
  p_idempotency_key UUID,
  p_purpose TEXT DEFAULT NULL,
  p_run_mode TEXT DEFAULT 'single',
  p_output_preset JSONB DEFAULT '{}'::jsonb,
  p_provider_config JSONB DEFAULT '{}'::jsonb
) RETURNS SETOF batch_lab.experiments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing batch_lab.experiments%ROWTYPE;
  v_set batch_lab.sample_sets%ROWTYPE;
  v_experiment batch_lab.experiments%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 0));

  IF p_run_mode NOT IN ('single', 'multi_turn')
     OR jsonb_typeof(p_output_preset) <> 'object'
     OR jsonb_typeof(p_provider_config) <> 'object'
     OR char_length(COALESCE(p_purpose, '')) > 2000 THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM batch_lab.experiments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.sample_set_id <> p_sample_set_id
       OR v_existing.source_environment <> p_source_environment
       OR v_existing.name <> btrim(p_name)
       OR v_existing.variants <> p_variants
       OR COALESCE(v_existing.purpose, '') <> COALESCE(btrim(p_purpose), '')
       OR v_existing.run_mode <> p_run_mode
       OR v_existing.output_preset <> p_output_preset
       OR v_existing.provider_config <> p_provider_config THEN
      RAISE EXCEPTION 'BATCH_LAB_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN NEXT v_existing;
    RETURN;
  END IF;

  SELECT * INTO v_set FROM batch_lab.sample_sets WHERE id = p_sample_set_id;
  IF NOT FOUND
     OR v_set.source_environment <> p_source_environment
     OR v_set.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR' USING ERRCODE = '22023';
  END IF;

  INSERT INTO batch_lab.experiments (
    name, sample_set_id, source_environment, variants, idempotency_key,
    purpose, run_mode, output_preset, provider_config
  )
  VALUES (
    btrim(p_name), p_sample_set_id, p_source_environment, p_variants, p_idempotency_key,
    NULLIF(btrim(COALESCE(p_purpose, '')), ''), p_run_mode, p_output_preset, p_provider_config
  )
  RETURNING * INTO v_experiment;

  RETURN NEXT v_experiment;
END;
$$;

REVOKE ALL ON FUNCTION batch_lab.create_experiment(
  TEXT, UUID, TEXT, JSONB, UUID, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_lab.create_experiment(
  TEXT, UUID, TEXT, JSONB, UUID, TEXT, TEXT, JSONB, JSONB
) TO service_role, postgres;

COMMIT;

-- Post-apply verification in test:
-- 1. SELECT deleted_at, deleted_reason FROM batch_lab.sample_sets LIMIT 1;
-- 2. SELECT purpose, run_mode, output_preset, provider_config FROM batch_lab.experiments LIMIT 1;
-- 3. Call batch_lab.create_experiment with the previous five required arguments and confirm defaults.
-- 4. Call batch_lab.create_experiment with all nine arguments and confirm metadata is frozen.
-- 5. SET ROLE anon; SELECT * FROM batch_lab.experiments; -- must remain permission denied.
