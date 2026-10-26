-- domain: experience, billing
-- A no-visible-token receipt releases the existing free reservation in the same transaction.
-- Depends on 20261026_first_token_visible_billing.sql. No historical data update.
-- Lock order remains request -> quota pair -> decision. No new privilege or object.
-- TEST first; production after pending-aware backend + visible billing activation.
-- Recovery: transaction rollback or forward-fix; never restore consumption for unseen replies.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE OR REPLACE FUNCTION experience.report_chat_first_token(p_user_id uuid,p_session_id uuid,p_report jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text; v_charge_id uuid;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0 JOIN experience.chat_history h ON h.id=r0.chat_history_id
  WHERE h.id=(p_report->>'assistant_message_id')::uuid AND h.user_id=p_user_id AND h.session_id=p_session_id
    AND h.revision=(p_report->>'revision')::integer AND r0.client_request_id=(p_report->>'request_id')::uuid FOR UPDATE OF r0;
  IF NOT FOUND THEN RETURN false; END IF;
  IF r.client_outcome <> 'missing' THEN RETURN true; END IF;
  v_outcome := p_report->>'outcome';
  IF v_outcome='observed' AND (p_report->>'first_token_visible_ms')::numeric >= r.first_token_deadline_ms THEN v_outcome := 'timed_out'; END IF;
  UPDATE experience.chat_generation_requests SET client_outcome=v_outcome,
    client_first_token_visible_ms=CASE WHEN v_outcome='observed' THEN (p_report->>'first_token_visible_ms')::numeric END,
    client_request_dispatched_ms=(p_report->>'request_dispatched_ms')::numeric,
    client_first_token_received_ms=(p_report->>'first_token_received_ms')::numeric,
    client_backgrounded=(p_report->>'backgrounded')::boolean,measurement_method=p_report->>'measurement_method',
    client_wait_finished_ms=(p_report->>'wait_finished_ms')::numeric,
    client_reason=p_report->>'reason',client_reported_at=clock_timestamp()
  WHERE chat_history_id=r.chat_history_id;
  -- Release immediately so a retry can use the same free entitlement; do not
  -- wait for the 30-second billing recovery scan. Receipt and release commit together.
  IF r.requires_visible_token AND v_outcome IN ('timed_out','not_observed') THEN
    SELECT llm_charge_id INTO v_charge_id FROM experience.chat_history WHERE id=r.chat_history_id;
    IF EXISTS(SELECT 1 FROM billing.character_free_chat_quota_decisions
              WHERE charge_key=v_charge_id AND status='reserved') THEN
      PERFORM billing.finalize_character_free_chat_round(v_charge_id,false);
    END IF;
  END IF;
  RETURN true;
END;
$$;

NOTIFY pgrst,'reload schema';
COMMIT;
