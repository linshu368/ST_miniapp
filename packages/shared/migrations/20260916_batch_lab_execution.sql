-- Batch Lab experiment execution state machine.
-- domain: internal research tooling (batch_lab)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS batch_lab;

CREATE TABLE IF NOT EXISTS batch_lab.experiments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  source_environment    TEXT NOT NULL CHECK (source_environment IN ('test', 'production')),
  sample_set_id         UUID NOT NULL REFERENCES batch_lab.sample_sets(id) ON DELETE RESTRICT,
  idempotency_key       UUID NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  variants              JSONB NOT NULL CHECK (jsonb_typeof(variants) = 'array' AND jsonb_array_length(variants) BETWEEN 2 AND 2),
  total_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
  completed_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (completed_attempts >= 0),
  failed_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  start_idempotency_key UUID UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  CONSTRAINT experiment_completion_bounds CHECK (completed_attempts + failed_attempts <= total_attempts)
);

CREATE INDEX IF NOT EXISTS idx_batch_lab_experiments_created
  ON batch_lab.experiments (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS batch_lab.experiment_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id         UUID NOT NULL REFERENCES batch_lab.experiments(id) ON DELETE RESTRICT,
  sample_set_id         UUID NOT NULL REFERENCES batch_lab.sample_sets(id) ON DELETE RESTRICT,
  sample_ordinal        INTEGER NOT NULL CHECK (sample_ordinal >= 0),
  variant_key           TEXT NOT NULL CHECK (variant_key ~ '^[a-z][a-z0-9_-]{0,31}$'),
  turn_index            INTEGER NOT NULL CHECK (turn_index BETWEEN 1 AND 5),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'blocked', 'unknown')),
  lease_owner           TEXT,
  lease_expires_at      TIMESTAMPTZ,
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  generation_id         TEXT,
  finish_reason         TEXT,
  raw_output            TEXT,
  display_result_id     UUID REFERENCES batch_lab.display_results(id) ON DELETE RESTRICT,
  error_code            TEXT,
  error_message         TEXT,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, sample_ordinal, variant_key, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_batch_lab_attempts_claim
  ON batch_lab.experiment_attempts (status, lease_expires_at, experiment_id, sample_ordinal, variant_key, turn_index);

ALTER TABLE batch_lab.experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_lab.experiment_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE batch_lab.experiments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE batch_lab.experiment_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE batch_lab.experiments TO service_role, postgres;
GRANT SELECT, INSERT, UPDATE ON TABLE batch_lab.experiment_attempts TO service_role, postgres;

CREATE OR REPLACE FUNCTION batch_lab.create_experiment(
  p_name TEXT,
  p_sample_set_id UUID,
  p_source_environment TEXT,
  p_variants JSONB,
  p_idempotency_key UUID
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

  SELECT * INTO v_existing FROM batch_lab.experiments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.sample_set_id <> p_sample_set_id
       OR v_existing.source_environment <> p_source_environment
       OR v_existing.name <> btrim(p_name)
       OR v_existing.variants <> p_variants THEN
      RAISE EXCEPTION 'BATCH_LAB_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN NEXT v_existing;
    RETURN;
  END IF;

  SELECT * INTO v_set FROM batch_lab.sample_sets WHERE id = p_sample_set_id;
  IF NOT FOUND OR v_set.source_environment <> p_source_environment THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR' USING ERRCODE = '22023';
  END IF;

  INSERT INTO batch_lab.experiments (name, sample_set_id, source_environment, variants, idempotency_key)
  VALUES (btrim(p_name), p_sample_set_id, p_source_environment, p_variants, p_idempotency_key)
  RETURNING * INTO v_experiment;

  RETURN NEXT v_experiment;
END;
$$;

CREATE OR REPLACE FUNCTION batch_lab.start_experiment(
  p_experiment_id UUID,
  p_source_environment TEXT,
  p_idempotency_key UUID
) RETURNS SETOF batch_lab.experiments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_experiment batch_lab.experiments%ROWTYPE;
  v_total INTEGER;
BEGIN
  SELECT * INTO v_experiment
  FROM batch_lab.experiments
  WHERE id = p_experiment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_experiment.source_environment <> p_source_environment THEN
    RAISE EXCEPTION 'BATCH_LAB_ENVIRONMENT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_experiment.status <> 'draft' THEN
    IF v_experiment.start_idempotency_key = p_idempotency_key THEN
      RETURN NEXT v_experiment;
      RETURN;
    END IF;
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO batch_lab.experiment_attempts (
    experiment_id, sample_set_id, sample_ordinal, variant_key, turn_index
  )
  SELECT v_experiment.id, v_experiment.sample_set_id, sample.ordinal, variant.key, turn.turn_index
  FROM batch_lab.sample_snapshots AS sample
  CROSS JOIN LATERAL jsonb_to_recordset(v_experiment.variants) AS variant(key TEXT, max_turns INTEGER)
  CROSS JOIN LATERAL generate_series(1, variant.max_turns) AS turn(turn_index)
  WHERE sample.sample_set_id = v_experiment.sample_set_id
  ON CONFLICT DO NOTHING;

  SELECT count(*)::integer INTO v_total
  FROM batch_lab.experiment_attempts
  WHERE experiment_id = v_experiment.id;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_NO_WORK' USING ERRCODE = '22023';
  END IF;

  UPDATE batch_lab.experiments
  SET status = 'queued',
      total_attempts = v_total,
      start_idempotency_key = p_idempotency_key,
      started_at = now()
  WHERE id = v_experiment.id
  RETURNING * INTO v_experiment;

  RETURN NEXT v_experiment;
END;
$$;

CREATE OR REPLACE FUNCTION batch_lab.claim_experiment_attempts(
  p_worker_id TEXT,
  p_limit INTEGER,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF batch_lab.experiment_attempts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT attempt.id
    FROM batch_lab.experiment_attempts AS attempt
    JOIN batch_lab.experiments AS experiment ON experiment.id = attempt.experiment_id
    WHERE experiment.status IN ('queued', 'running')
      AND attempt.status = 'pending'
      AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= now())
      AND NOT EXISTS (
        SELECT 1
        FROM batch_lab.experiment_attempts AS prior
        WHERE prior.experiment_id = attempt.experiment_id
          AND prior.sample_ordinal = attempt.sample_ordinal
          AND prior.variant_key = attempt.variant_key
          AND prior.turn_index < attempt.turn_index
          AND prior.status IN ('failed', 'blocked', 'unknown')
      )
      AND (
        attempt.turn_index = 1
        OR EXISTS (
          SELECT 1
          FROM batch_lab.experiment_attempts AS prev
          WHERE prev.experiment_id = attempt.experiment_id
            AND prev.sample_ordinal = attempt.sample_ordinal
            AND prev.variant_key = attempt.variant_key
            AND prev.turn_index = attempt.turn_index - 1
            AND prev.status = 'succeeded'
        )
      )
    ORDER BY attempt.created_at, attempt.id
    FOR UPDATE OF attempt SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE batch_lab.experiment_attempts AS attempt
  SET status = 'running',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt.attempt_count + 1,
      started_at = COALESCE(attempt.started_at, now())
  FROM candidates
  WHERE attempt.id = candidates.id
  RETURNING attempt.*;

  UPDATE batch_lab.experiments AS experiment
  SET status = 'running'
  WHERE status = 'queued'
    AND EXISTS (
      SELECT 1 FROM batch_lab.experiment_attempts AS attempt
      WHERE attempt.experiment_id = experiment.id AND attempt.status = 'running'
    );
END;
$$;

CREATE OR REPLACE FUNCTION batch_lab.refresh_experiment_counts(p_experiment_id UUID)
RETURNS SETOF batch_lab.experiments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_experiment batch_lab.experiments%ROWTYPE;
  v_completed INTEGER;
  v_failed INTEGER;
  v_total INTEGER;
BEGIN
  SELECT count(*)::integer INTO v_total FROM batch_lab.experiment_attempts WHERE experiment_id = p_experiment_id;
  SELECT count(*)::integer INTO v_completed FROM batch_lab.experiment_attempts WHERE experiment_id = p_experiment_id AND status = 'succeeded';
  SELECT count(*)::integer INTO v_failed FROM batch_lab.experiment_attempts WHERE experiment_id = p_experiment_id AND status IN ('failed', 'blocked', 'unknown');

  UPDATE batch_lab.experiments
  SET total_attempts = v_total,
      completed_attempts = v_completed,
      failed_attempts = v_failed,
      status = CASE
        WHEN status = 'cancelled' THEN status
        WHEN v_total > 0 AND v_completed + v_failed = v_total AND v_failed = 0 THEN 'completed'
        WHEN v_total > 0 AND v_completed + v_failed = v_total AND v_failed > 0 THEN 'failed'
        ELSE status
      END,
      completed_at = CASE
        WHEN v_total > 0 AND v_completed + v_failed = v_total THEN COALESCE(completed_at, now())
        ELSE completed_at
      END
  WHERE id = p_experiment_id
  RETURNING * INTO v_experiment;

  RETURN NEXT v_experiment;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA batch_lab FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_lab.create_experiment(TEXT, UUID, TEXT, JSONB, UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION batch_lab.start_experiment(UUID, TEXT, UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION batch_lab.claim_experiment_attempts(TEXT, INTEGER, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION batch_lab.refresh_experiment_counts(UUID) TO service_role, postgres;

COMMENT ON TABLE batch_lab.experiments IS
  'Immutable Batch Lab experiment configuration plus execution counters; no wallet reservation and no source-domain writes.';
COMMENT ON TABLE batch_lab.experiment_attempts IS
  'Leased internal research generation attempts. Successful raw outputs are immutable facts for later analysis.';

COMMIT;

-- Post-apply verification:
-- 1. SET ROLE anon; SELECT * FROM batch_lab.experiments; -- must be permission denied
-- 2. Start the same experiment twice with the same idempotency key; it must return the same row.
-- 3. Run two workers against pending attempts; each attempt must be claimed once via SKIP LOCKED.
-- 4. Rollback/forward-fix: close Batch Lab execution endpoints, then apply a reviewed migration to
--    drop experiment_attempts, experiments and execution functions only after preserving any needed audit data.
