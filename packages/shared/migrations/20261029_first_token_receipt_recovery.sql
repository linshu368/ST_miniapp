-- domain: experience
-- Extend the existing once-only receipt RPC; no table/index/job/backfill or billing-policy change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION experience.report_chat_first_token(p_user_id uuid,p_session_id uuid,p_report jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text; v_reason text; v_charge_id uuid;
  v_v4 boolean := COALESCE(p_report->>'measurement_method'='client_committed_v4',false);
  v_delivery_failed boolean; v_lookup_ids uuid[]; v_history_id uuid;
BEGIN
  v_history_id := (p_report->>'assistant_message_id')::uuid;
  IF v_history_id IS NULL THEN
    -- Only a genuine unavailable v4 result may arrive before its SSE identity.
    IF NOT v_v4 OR NOT COALESCE((p_report->>'outcome') IN ('timed_out','not_observed'),false)
       OR p_report->>'revision' IS NOT NULL THEN RETURN false; END IF;
    -- Existing client_request_id index, at most two ownership-checked candidates.
    -- Replayed request identities are ambiguous; never guess a generation to bill.
    SELECT array_agg(candidate.chat_history_id) INTO v_lookup_ids FROM (
      SELECT r0.chat_history_id FROM experience.chat_generation_requests r0
      JOIN experience.chat_history h ON h.id=r0.chat_history_id
      WHERE r0.client_request_id=(p_report->>'request_id')::uuid
        AND h.user_id=p_user_id AND h.session_id=p_session_id LIMIT 2
    ) candidate;
    IF COALESCE(cardinality(v_lookup_ids),0)<>1 THEN RETURN false; END IF;
    v_history_id:=v_lookup_ids[1];
  END IF;
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0 JOIN experience.chat_history h ON h.id=r0.chat_history_id
  WHERE h.id=v_history_id AND h.user_id=p_user_id AND h.session_id=p_session_id
    AND (p_report->>'assistant_message_id' IS NULL OR h.revision=(p_report->>'revision')::integer)
    AND r0.client_request_id=(p_report->>'request_id')::uuid FOR UPDATE OF r0;
  IF NOT FOUND THEN RETURN false; END IF;
  -- A known v4 request cannot be downgraded by an old report. Legacy requests
  -- without an advertised method may still be served during rolling deployment.
  IF r.measurement_method='client_committed_v4' AND NOT v_v4 THEN RETURN false; END IF;
  -- v4 records one terminal observation. Replays do no UPDATE, even when recovery
  -- later delivers text; legacy v3's late-display behavior remains historical only.
  IF r.client_outcome <> 'missing' AND (v_v4 OR r.measurement_method='client_committed_v4'
      OR NOT (r.recoverable_delivery AND r.client_outcome <> 'observed' AND p_report->>'outcome'='observed')) THEN RETURN true; END IF;
  v_outcome := p_report->>'outcome';
  v_reason := p_report->>'reason';
  IF (v_v4 OR NOT r.recoverable_delivery) AND v_outcome='observed'
     AND (p_report->>'first_token_visible_ms')::numeric >= r.first_token_deadline_ms THEN
    v_outcome := 'timed_out';
    IF v_v4 THEN v_reason := 'not_visible'; END IF;
  END IF;
  -- Reception is a diagnostic stage, not delivery: a token received at 2s but
  -- committed at/after the frozen deadline is a foreground cutoff under v4.
  v_delivery_failed := COALESCE((r.recoverable_delivery AND (p_report->>'backgrounded')::boolean=false
    AND (v_reason IN ('server_timeout','primary_timeout','fallback_timeout')
      OR (v_outcome='timed_out' AND (v_v4 OR (p_report->>'first_token_received_ms')::numeric IS NULL
        OR (p_report->>'first_token_received_ms')::numeric >= r.first_token_deadline_ms)))),false);
  UPDATE experience.chat_generation_requests SET client_outcome=v_outcome,
    client_delivery_failed=client_delivery_failed OR v_delivery_failed,
    client_first_token_visible_ms=CASE WHEN v_outcome='observed' THEN (p_report->>'first_token_visible_ms')::numeric END,
    client_request_dispatched_ms=(p_report->>'request_dispatched_ms')::numeric,
    client_first_token_received_ms=(p_report->>'first_token_received_ms')::numeric,
    client_backgrounded=(p_report->>'backgrounded')::boolean,measurement_method=p_report->>'measurement_method',
    client_wait_finished_ms=(p_report->>'wait_finished_ms')::numeric,
    client_reason=v_reason,client_reported_at=clock_timestamp()
  WHERE chat_history_id=r.chat_history_id;
  -- Release a genuine cutoff's reservation in this same receipt transaction.
  -- Departure/background and explicit user stop do not become free cancellations.
  IF r.requires_visible_token AND v_outcome IN ('timed_out','not_observed')
    AND COALESCE(v_reason,'') <> 'cancelled'
    AND (NOT r.recoverable_delivery OR v_delivery_failed) THEN
    SELECT llm_charge_id INTO v_charge_id FROM experience.chat_history WHERE id=r.chat_history_id;
    IF EXISTS(SELECT 1 FROM billing.character_free_chat_quota_decisions
              WHERE charge_key=v_charge_id AND status='reserved') THEN
      PERFORM billing.finalize_character_free_chat_round(v_charge_id,false);
    END IF;
  END IF;
  RETURN true;
END;
$$;

COMMIT;
