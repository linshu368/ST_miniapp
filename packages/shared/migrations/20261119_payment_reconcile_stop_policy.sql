-- domain: billing
-- J: automatic reconciliation state belongs to payment_reconcile_jobs, never payment_orders.
-- ops.payment_events is read only for the bounded one-time backfill of confirmed post-expiry unpaid results.
-- Release: isolated tests -> TEST -> production migration workflow -> both reconciliation services.
-- Recovery: keep additive columns/RPC; restore the previous claim body and 7-day application window.
-- Rebuilding removed jobs is a separate reviewed recovery step; never alter orders, wallets or settlements.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE billing.payment_reconcile_jobs
  ADD COLUMN IF NOT EXISTS unpaid_confirmations integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_unpaid_claim_at timestamptz;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint
    WHERE conrelid = 'billing.payment_reconcile_jobs'::regclass
      AND conname = 'payment_reconcile_jobs_unpaid_confirmations_check') THEN
    ALTER TABLE billing.payment_reconcile_jobs
      ADD CONSTRAINT payment_reconcile_jobs_unpaid_confirmations_check
      CHECK (unpaid_confirmations BETWEEN 0 AND 3);
  END IF;
END;
$constraints$;

COMMENT ON TABLE billing.payment_reconcile_jobs IS
  'Payment reconciliation jobs (J): automatic queries stop after eight hours or three confirmed post-expiry unpaid responses; stopped rows persist until age/settlement cleanup.';

COMMENT ON COLUMN billing.payment_reconcile_jobs.unpaid_confirmations IS
  'Confirmed automatic unpaid responses after local expiry; capped at three, then automatic queries stop.';
COMMENT ON COLUMN billing.payment_reconcile_jobs.last_unpaid_claim_at IS
  'Claim timestamp already counted as unpaid; deduplicates retries independently of total claim attempts.';

-- Only existing, recoverable tasks inside the new window are eligible. Event keys are unique;
-- LIMIT bounds each history lookup because only three confirmed results are needed.
WITH history AS (
  SELECT job.order_id, (
    SELECT count(*)::integer FROM (
      SELECT e.event_key FROM ops.payment_events e
      WHERE e.order_id = o.id AND e.event_kind IN ('fast_reconcile', 'expiry_reconcile')
        AND e.stage = 'query' AND e.source = 'gateway' AND e.outcome = 'unpaid'
        AND e.occurred_at >= o.expires_at AND e.occurred_at <= transaction_timestamp()
      LIMIT 3
    ) confirmed
  ) AS confirmations
  FROM billing.payment_reconcile_jobs job
  JOIN billing.payment_orders o ON o.id = job.order_id
  WHERE o.id LIKE 'EP%' AND o.status IN ('pending', 'expired')
    AND NOT o.credits_added AND NOT o.fulfillment_applied
    AND o.created_at >= transaction_timestamp() - interval '8 hours'
    AND o.expires_at <= transaction_timestamp()
)
UPDATE billing.payment_reconcile_jobs job
SET unpaid_confirmations = greatest(job.unpaid_confirmations, history.confirmations)
FROM history WHERE job.order_id = history.order_id
  AND job.unpaid_confirmations < history.confirmations;

CREATE OR REPLACE FUNCTION billing.claim_payment_reconcile_jobs(
  p_now timestamptz, p_window_start timestamptz, p_limit integer,
  p_base_delay_seconds integer, p_max_delay_seconds integer
)
RETURNS SETOF billing.payment_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  v_window_start timestamptz;
BEGIN
  IF p_now IS NULL OR p_window_start IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_base_delay_seconds IS NULL OR p_base_delay_seconds < 1
     OR p_max_delay_seconds IS NULL OR p_max_delay_seconds < p_base_delay_seconds THEN
    RAISE EXCEPTION 'invalid payment reconcile claim arguments' USING ERRCODE = '22023';
  END IF;
  -- The DB cap also protects mixed-version deployments still passing the former seven-day window.
  v_window_start := greatest(p_window_start, p_now - interval '8 hours');
  DELETE FROM billing.payment_reconcile_jobs job USING billing.payment_orders o
  WHERE o.id = job.order_id
    AND (o.status NOT IN ('pending', 'expired') OR o.credits_added OR o.fulfillment_applied
      OR o.created_at < v_window_start OR o.id NOT LIKE 'EP%');

  RETURN QUERY
  WITH due AS (
    SELECT job.order_id FROM billing.payment_reconcile_jobs job
    WHERE job.next_attempt_at <= p_now AND job.unpaid_confirmations < 3
    ORDER BY job.next_attempt_at, job.order_id LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE billing.payment_reconcile_jobs job
    SET attempts = job.attempts + 1, last_attempt_at = p_now,
      next_attempt_at = p_now + make_interval(secs => least(
        p_base_delay_seconds * power(2::double precision, least(job.attempts, 30)),
        p_max_delay_seconds::double precision))
    FROM due WHERE job.order_id = due.order_id RETURNING job.order_id
  )
  SELECT o.* FROM billing.payment_orders o JOIN claimed ON claimed.order_id = o.id
  ORDER BY o.created_at, o.id;
END;
$function$;

CREATE OR REPLACE FUNCTION billing.record_payment_reconcile_unpaid(
  p_order_id text, p_claimed_at timestamptz
)
RETURNS TABLE(confirmations integer, stopped boolean, recorded boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  v_order billing.payment_orders%ROWTYPE;
  v_job billing.payment_reconcile_jobs%ROWTYPE;
  v_count integer;
BEGIN
  IF p_order_id IS NULL OR p_claimed_at IS NULL THEN
    RAISE EXCEPTION 'invalid unpaid reconciliation result' USING ERRCODE = '22023';
  END IF;
  -- Lock order before job, as for order deletion/FK cascades. Settlement cannot race this state check.
  SELECT o.* INTO v_order FROM billing.payment_orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.id NOT LIKE 'EP%' OR v_order.status NOT IN ('pending', 'expired')
    OR v_order.credits_added OR v_order.fulfillment_applied
    OR v_order.created_at < clock_timestamp() - interval '8 hours'
    OR v_order.expires_at > p_claimed_at THEN
    RETURN QUERY SELECT 0, false, false;
    RETURN;
  END IF;
  SELECT job.* INTO v_job FROM billing.payment_reconcile_jobs job
  WHERE job.order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, false, false;
    RETURN;
  END IF;
  IF v_job.last_attempt_at IS DISTINCT FROM p_claimed_at
    OR v_job.last_unpaid_claim_at = p_claimed_at OR v_job.unpaid_confirmations >= 3 THEN
    RETURN QUERY SELECT v_job.unpaid_confirmations, v_job.unpaid_confirmations >= 3, false;
    RETURN;
  END IF;
  UPDATE billing.payment_reconcile_jobs job
  SET unpaid_confirmations = job.unpaid_confirmations + 1, last_unpaid_claim_at = p_claimed_at
  WHERE job.order_id = p_order_id RETURNING job.unpaid_confirmations INTO v_count;
  RETURN QUERY SELECT v_count, v_count >= 3, true;
END;
$function$;

REVOKE ALL ON FUNCTION billing.record_payment_reconcile_unpaid(text, timestamptz) FROM PUBLIC;
-- Preserve the existing claim ACL; explicitly protect the new service-only result writer.
DO $grants$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION billing.record_payment_reconcile_unpaid(text,timestamptz) FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION billing.record_payment_reconcile_unpaid(text,timestamptz) TO service_role;
  END IF;
END;
$grants$;
COMMENT ON FUNCTION billing.record_payment_reconcile_unpaid(text,timestamptz) IS
  'Count a confirmed post-expiry automatic unpaid result once per current claim; never writes payment or wallet state.';

COMMIT;
