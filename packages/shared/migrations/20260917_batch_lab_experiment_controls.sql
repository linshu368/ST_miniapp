-- 20260917: Batch Lab experiment start/stop/delete controls for the internal workbench.
-- domain: batch_lab
--
-- Stop is cooperative: it prevents new leases immediately, marks pending attempts blocked, and
-- lets an already leased upstream request settle normally. Delete is soft-only and is rejected
-- while an experiment is queued/running so audit facts and in-flight writes remain valid.
-- Rollback: disable the control endpoints, then drop the two functions, active index and
-- experiments.deleted_at in a reviewed forward migration. Existing cancelled rows stay readable.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE batch_lab.experiments
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_batch_lab_experiments_active_created
  ON batch_lab.experiments (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION batch_lab.stop_experiment(
  p_experiment_id UUID,
  p_source_environment TEXT
) RETURNS SETOF batch_lab.experiments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_experiment batch_lab.experiments%ROWTYPE;
BEGIN
  SELECT * INTO v_experiment
  FROM batch_lab.experiments
  WHERE id = p_experiment_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_experiment.source_environment <> p_source_environment THEN
    RAISE EXCEPTION 'BATCH_LAB_ENVIRONMENT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_experiment.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  UPDATE batch_lab.experiment_attempts
  SET status = 'blocked',
      error_code = 'BATCH_LAB_EXPERIMENT_STATE_CONFLICT',
      error_message = 'cancelled by operator',
      completed_at = now()
  WHERE experiment_id = p_experiment_id
    AND status = 'pending';

  UPDATE batch_lab.experiments
  SET status = 'cancelled',
      failed_attempts = (
        SELECT count(*)::integer
        FROM batch_lab.experiment_attempts AS attempt
        WHERE attempt.experiment_id = p_experiment_id
          AND attempt.status IN ('failed', 'blocked', 'unknown')
      ),
      completed_at = COALESCE(completed_at, now())
  WHERE id = p_experiment_id
  RETURNING * INTO v_experiment;

  RETURN NEXT v_experiment;
END;
$$;

CREATE OR REPLACE FUNCTION batch_lab.soft_delete_experiment(
  p_experiment_id UUID,
  p_source_environment TEXT
) RETURNS TABLE(id UUID, deleted_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_experiment batch_lab.experiments%ROWTYPE;
BEGIN
  SELECT * INTO v_experiment
  FROM batch_lab.experiments AS experiment
  WHERE experiment.id = p_experiment_id
  FOR UPDATE;

  IF NOT FOUND OR v_experiment.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_experiment.source_environment <> p_source_environment THEN
    RAISE EXCEPTION 'BATCH_LAB_ENVIRONMENT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_experiment.status IN ('queued', 'running') THEN
    RAISE EXCEPTION 'BATCH_LAB_EXPERIMENT_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE batch_lab.experiments AS experiment
  SET deleted_at = now()
  WHERE experiment.id = p_experiment_id
  RETURNING experiment.id, experiment.deleted_at;
END;
$$;

REVOKE ALL ON FUNCTION batch_lab.stop_experiment(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION batch_lab.soft_delete_experiment(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_lab.stop_experiment(UUID, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION batch_lab.soft_delete_experiment(UUID, TEXT) TO service_role, postgres;

COMMIT;

-- Test verification:
-- 1. Stop a queued experiment: status becomes cancelled and no pending attempt remains claimable.
-- 2. Stop a running experiment: its current lease may finish, but no additional attempt is claimed.
-- 3. Delete draft/completed/cancelled rows: list hides them while detail/audit rows remain stored.
-- 4. Delete queued/running rows and stop terminal rows: both must fail with state conflict.
-- 5. SET ROLE anon; both functions must be permission denied.