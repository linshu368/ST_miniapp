-- 20260917: Atomically claim Batch Lab attempts for one selected experiment.
-- domain: batch_lab
--
-- This is a forward-only compatibility addition. It does not change the existing global worker
-- claim function, attempt state machine, source schemas, or billing behavior.
-- Rollback: revoke and drop batch_lab.claim_experiment_attempts_for_experiment after disabling
-- the targeted worker endpoint. Already claimed attempts remain governed by their normal leases.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION batch_lab.claim_experiment_attempts_for_experiment(
  p_experiment_id UUID,
  p_worker_id TEXT,
  p_limit INTEGER,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF batch_lab.experiment_attempts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 20 OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT attempt.id
    FROM batch_lab.experiment_attempts AS attempt
    JOIN batch_lab.experiments AS experiment ON experiment.id = attempt.experiment_id
    WHERE attempt.experiment_id = p_experiment_id
      AND experiment.status IN ('queued', 'running')
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
          FROM batch_lab.experiment_attempts AS previous
          WHERE previous.experiment_id = attempt.experiment_id
            AND previous.sample_ordinal = attempt.sample_ordinal
            AND previous.variant_key = attempt.variant_key
            AND previous.turn_index = attempt.turn_index - 1
            AND previous.status = 'succeeded'
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

  UPDATE batch_lab.experiments
  SET status = 'running'
  WHERE id = p_experiment_id
    AND status = 'queued'
    AND EXISTS (
      SELECT 1
      FROM batch_lab.experiment_attempts AS attempt
      WHERE attempt.experiment_id = p_experiment_id
        AND attempt.status = 'running'
    );
END;
$$;

REVOKE ALL ON FUNCTION batch_lab.claim_experiment_attempts_for_experiment(
  UUID, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_lab.claim_experiment_attempts_for_experiment(
  UUID, TEXT, INTEGER, INTEGER
) TO service_role, postgres;

COMMENT ON FUNCTION batch_lab.claim_experiment_attempts_for_experiment(UUID, TEXT, INTEGER, INTEGER)
IS 'Claims a bounded attempt batch from exactly one Batch Lab experiment using leases and SKIP LOCKED.';

COMMIT;

-- Test verification:
-- 1. Queue two experiments and call this function for one id; returned rows must all match that id.
-- 2. Call concurrently for the same id; no attempt id may be returned twice.
-- 3. SET ROLE anon; calling this function must be permission denied.