-- domain: experience owns recoverable reply state; billing owns eligibility/once-only charge.
-- Additive, no historical billing/data rewrite. TEST before production; forward-fix on rollback.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE experience.chat_generation_requests
 ADD COLUMN IF NOT EXISTS recoverable_delivery boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS client_delivery_failed boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS server_first_token_ready_ms numeric CHECK (server_first_token_ready_ms >= 0);
ALTER TABLE experience.chat_history ADD COLUMN IF NOT EXISTS first_token_preview jsonb;
COMMENT ON COLUMN experience.chat_history.first_token_preview IS 'One bounded, public-text first-token checkpoint for recovery; never an analytics payload.';
-- Preserve the existing view projection, provider joins, owner, ACL and security mode.
DO $$ DECLARE d text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='experience.current_chat_history'::regclass AND attname='first_token_preview' AND NOT attisdropped) THEN
  d:=pg_get_viewdef('experience.current_chat_history'::regclass,true);
  IF position('FROM experience.chat_history h' IN d)>0 THEN
   d:=replace(d,'FROM experience.chat_history h',', h.first_token_preview FROM experience.chat_history h');
  ELSIF position('FROM experience.chat_history' IN d)>0 THEN
   d:=replace(d,'FROM experience.chat_history',', chat_history.first_token_preview FROM experience.chat_history');
  ELSE RAISE EXCEPTION 'Unexpected current history projection'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW experience.current_chat_history AS '||d;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION experience.record_chat_delivery_preview(
 p_history_id uuid,p_revision integer,p_ready_ms numeric,p_kind text,p_text text
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE;
BEGIN
 IF p_kind NOT IN ('delta','reasoning') OR p_ready_ms IS NULL OR p_ready_ms<0 OR length(btrim(p_text))=0 OR length(p_text)>2048 THEN
  RAISE EXCEPTION 'Invalid delivery checkpoint' USING ERRCODE='22023';
 END IF;
 SELECT * INTO h FROM experience.chat_history WHERE id=p_history_id AND revision=p_revision FOR UPDATE;
 IF NOT FOUND OR h.status<>'streaming' OR h.llm_finish_reason IS NOT NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=h.id AND recoverable_delivery AND p_ready_ms<first_token_deadline_ms) THEN RETURN false; END IF;
 UPDATE experience.chat_history SET first_token_preview=COALESCE(first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text)) WHERE id=h.id;
 UPDATE experience.chat_generation_requests SET server_first_token_ready_ms=COALESCE(server_first_token_ready_ms,p_ready_ms) WHERE chat_history_id=h.id;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION experience.record_chat_delivery_preview(uuid,integer,numeric,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION experience.record_chat_delivery_preview(uuid,integer,numeric,text,text) TO service_role,postgres;

CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE; v_fallback text := COALESCE(p_input->>'fallback_model_id','deepseek/deepseek-v4.1-flash');
BEGIN
  IF (p_input ? 'fallback_model_id' AND jsonb_typeof(p_input->'fallback_model_id') IS DISTINCT FROM 'string')
     OR length(v_fallback) > 200
     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Invalid frozen fallback model ID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL
     OR (p_input ? 'snapshot' AND h.llm_charge_id::text IS DISTINCT FROM p_input#>>'{snapshot,charge_id}') THEN
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='PT409';
  END IF;
  IF p_input ? 'snapshot' THEN
    UPDATE experience.chat_history SET llm_billing_snapshot=p_input->'snapshot' WHERE id=p_history_id;
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN
    IF NOT EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id AND client_request_id=(p_input->>'request_id')::uuid AND (NOT (p_input ? 'fallback_model_id') OR fallback_model_id=v_fallback) AND fallback_timeout_ms IS NOT DISTINCT FROM (p_input->>'fallback_timeout_ms')::integer) THEN
      RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms,recoverable_delivery)
  VALUES(p_history_id,(p_input->>'request_id')::uuid,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer,COALESCE((p_input->>'recoverable_delivery')::boolean,false));
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$$;


CREATE OR REPLACE FUNCTION experience.cancel_chat_generation(
  p_session_id uuid,p_history_id uuid,p_reason text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE; r experience.chat_generation_requests%ROWTYPE;
  v_finish text; v_deadline boolean;
BEGIN
  IF p_reason IS NOT NULL AND p_reason NOT IN ('user_stop','first_token_timeout') THEN
    RAISE EXCEPTION 'Invalid cancellation intent' USING ERRCODE='22023';
  END IF;
  -- Same history-first order as begin-observation; no request lock while waiting on history.
  SELECT * INTO h FROM experience.chat_history
    WHERE id=p_history_id AND session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR h.status<>'streaming' OR h.llm_finish_reason IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO r FROM experience.chat_generation_requests WHERE chat_history_id=h.id;
  -- Legacy pages may report viewport absence as cancellation. New turns are server-owned.
  IF r.recoverable_delivery AND p_reason='first_token_timeout' THEN RETURN false; END IF;
  v_deadline := COALESCE(r.first_token_timeout,false)
    OR r.server_timeout_stage IN ('global','primary','fallback') OR
    ((NOT r.recoverable_delivery OR r.server_first_token_ready_ms IS NULL)
      AND r.client_outcome IS DISTINCT FROM 'observed' AND clock_timestamp() >=
      r.request_received_at + make_interval(secs=>r.first_token_deadline_ms::double precision/1000));
  IF v_deadline THEN
    v_finish := 'timeout';
  ELSIF p_reason='first_token_timeout' AND r.client_outcome IS DISTINCT FROM 'observed' THEN
    -- An unverified caller cannot write an authoritative free timeout. Existing
    -- watchdog/polling will confirm the real cutoff; never charge a genuine timeout.
    RETURN false;
  ELSIF COALESCE(r.user_stop_billing_enabled,false) THEN
    v_finish := 'user_cancelled';
  ELSE
    v_finish := 'cancelled';
  END IF;
  UPDATE experience.chat_history SET llm_finish_reason=v_finish WHERE id=h.id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION experience.cancel_chat_generation(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION experience.cancel_chat_generation(uuid,uuid,text) TO service_role,postgres;


CREATE OR REPLACE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; h experience.chat_history%ROWTYPE;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0
  JOIN experience.chat_history h0 ON h0.id=r0.chat_history_id
  WHERE h0.llm_charge_id=p_charge_key FOR UPDATE OF r0;
  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
  IF r.recoverable_delivery THEN
    SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
    IF r.client_delivery_failed OR r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
       OR h.llm_finish_reason='timeout'
       OR (r.client_backgrounded=false AND r.client_reason IS DISTINCT FROM 'page_left' AND
         ((r.client_outcome='timed_out' AND (r.client_first_token_received_ms IS NULL OR r.client_first_token_received_ms >= r.first_token_deadline_ms))
           OR (r.client_outcome='observed' AND r.client_first_token_received_ms >= r.first_token_deadline_ms)))
      THEN RETURN 'waived'; END IF;
    IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
       AND h.llm_billing_snapshot->>'charge_id'=p_charge_key::text
       AND h.llm_billing_snapshot->>'billing_mode'='fixed_tier'
       AND jsonb_typeof(h.llm_billing_snapshot->'payable_credits')='number'
      THEN RETURN 'user_stopped'; END IF;
    IF r.client_outcome='missing' THEN
      IF clock_timestamp() >= r.request_received_at + make_interval(secs=>r.first_token_deadline_ms::double precision/1000+15) THEN RETURN 'waived'; END IF;
      RETURN 'pending';
    END IF;
    -- A durable complete reply belongs to the user even if they left before reading it.
    IF h.status='success' AND h.llm_finish_reason='stop' AND length(btrim(COALESCE(h.assistant_reply,'')))>0
       AND r.delivery_attempt_id IS NOT NULL AND r.server_first_token_ready_ms < r.first_token_deadline_ms
      THEN RETURN 'visible'; END IF;
    IF h.status <> 'streaming' THEN RETURN 'waived'; END IF;
    RETURN 'pending';
  END IF;
  -- A system cutoff cannot become chargeable through a competing stop click.
  IF r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
     OR r.client_outcome='timed_out'
     OR (r.client_outcome='not_observed' AND r.client_reason IN
       ('server_timeout','primary_timeout','fallback_timeout')) THEN RETURN 'waived'; END IF;
  SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
  IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
     AND h.llm_billing_snapshot->>'charge_id'=p_charge_key::text
     AND h.llm_billing_snapshot->>'billing_mode'='fixed_tier'
     AND jsonb_typeof(h.llm_billing_snapshot->'payable_credits')='number'
    THEN RETURN 'user_stopped'; END IF;
  IF r.client_outcome='observed' AND r.client_first_token_visible_ms IS NOT NULL
     AND r.client_first_token_visible_ms < r.first_token_deadline_ms THEN RETURN 'visible'; END IF;
  IF r.client_outcome IN ('timed_out','not_observed')
     OR clock_timestamp() >= r.request_received_at
       + make_interval(secs => r.first_token_deadline_ms::double precision / 1000 + 15)
    THEN RETURN 'waived'; END IF;
  RETURN 'pending';
END;
$$;
CREATE OR REPLACE FUNCTION experience.report_chat_first_token(p_user_id uuid,p_session_id uuid,p_report jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text; v_charge_id uuid;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0 JOIN experience.chat_history h ON h.id=r0.chat_history_id
  WHERE h.id=(p_report->>'assistant_message_id')::uuid AND h.user_id=p_user_id AND h.session_id=p_session_id
    AND h.revision=(p_report->>'revision')::integer AND r0.client_request_id=(p_report->>'request_id')::uuid FOR UPDATE OF r0;
  IF NOT FOUND THEN RETURN false; END IF;
  IF r.client_outcome <> 'missing' AND NOT (r.recoverable_delivery AND r.client_outcome <> 'observed'
      AND p_report->>'outcome'='observed') THEN RETURN true; END IF;
  v_outcome := p_report->>'outcome';
  IF NOT r.recoverable_delivery AND v_outcome='observed' AND (p_report->>'first_token_visible_ms')::numeric >= r.first_token_deadline_ms THEN v_outcome := 'timed_out'; END IF;
  UPDATE experience.chat_generation_requests SET client_outcome=v_outcome,
    client_delivery_failed=client_delivery_failed OR COALESCE((r.recoverable_delivery AND (p_report->>'backgrounded')::boolean=false
      AND (p_report->>'reason' IN ('server_timeout','primary_timeout','fallback_timeout')
        OR (v_outcome='timed_out' AND ((p_report->>'first_token_received_ms')::numeric IS NULL
          OR (p_report->>'first_token_received_ms')::numeric >= r.first_token_deadline_ms)))),false),
    client_first_token_visible_ms=CASE WHEN v_outcome='observed' THEN (p_report->>'first_token_visible_ms')::numeric END,
    client_request_dispatched_ms=(p_report->>'request_dispatched_ms')::numeric,
    client_first_token_received_ms=(p_report->>'first_token_received_ms')::numeric,
    client_backgrounded=(p_report->>'backgrounded')::boolean,measurement_method=p_report->>'measurement_method',
    client_wait_finished_ms=(p_report->>'wait_finished_ms')::numeric,
    client_reason=p_report->>'reason',client_reported_at=clock_timestamp()
  WHERE chat_history_id=r.chat_history_id;
  -- Release immediately so a retry can use the same free entitlement; do not
  -- wait for the 30-second billing recovery scan. Receipt and release commit together.
  IF r.requires_visible_token AND v_outcome IN ('timed_out','not_observed')
    AND COALESCE(p_report->>'reason','') <> 'cancelled'
    AND (NOT r.recoverable_delivery OR ((p_report->>'backgrounded')::boolean=false
      AND (p_report->>'reason' IN ('server_timeout','primary_timeout','fallback_timeout')
        OR (v_outcome='timed_out' AND ((p_report->>'first_token_received_ms')::numeric IS NULL
          OR (p_report->>'first_token_received_ms')::numeric >= r.first_token_deadline_ms))))) THEN
    SELECT llm_charge_id INTO v_charge_id FROM experience.chat_history WHERE id=r.chat_history_id;
    IF EXISTS(SELECT 1 FROM billing.character_free_chat_quota_decisions
              WHERE charge_key=v_charge_id AND status='reserved') THEN
      PERFORM billing.finalize_character_free_chat_round(v_charge_id,false);
    END IF;
  END IF;
  RETURN true;
END;
$$;


CREATE OR REPLACE VIEW miniapp_analytics.chat_first_token_facts WITH(security_invoker=true) AS
SELECT r.chat_history_id,r.request_received_at,r.requested_model_id,r.requested_provider,r.requested_provider_model_id,r.catalog_version,
 r.client_reason,r.measurement_method,
 r.primary_timeout_ms,r.first_token_deadline_ms,r.timeout_rate_target,r.mode,
 r.fallback_triggered_ms IS NOT NULL AS fallback_started,d.role AS delivery_role,
 r.billing_rejected,r.first_token_timeout AS server_first_token_timeout,r.client_outcome,r.client_first_token_visible_ms,r.client_backgrounded,
 r.client_request_dispatched_ms,r.client_first_token_received_ms,r.first_token_emitted_ms,
 CASE WHEN r.fallback_triggered_ms IS NOT NULL THEN r.fallback_triggered_ms-p.dispatch_offset_ms ELSE p.first_token_ms END AS primary_wait_ms,
 f.dispatch_offset_ms-r.fallback_triggered_ms AS fallback_dispatch_delay_ms,
 p.dispatch_offset_ms AS primary_dispatch_offset_ms,p.headers_ms AS primary_headers_ms,p.first_chunk_ms AS primary_first_chunk_ms,
 f.dispatch_offset_ms AS fallback_dispatch_offset_ms,f.headers_ms AS fallback_headers_ms,f.first_chunk_ms AS fallback_first_chunk_ms,
 p.provider_name AS primary_provider_name,f.provider_name AS fallback_provider_name,
 p.provider_reported_model AS primary_provider_reported_model,f.provider_reported_model AS fallback_provider_reported_model,
 p.provider_latency_scope AS primary_provider_latency_scope,f.provider_latency_scope AS fallback_provider_latency_scope,
 p.first_token_ms AS primary_actual_first_token_ms,f.first_token_ms AS fallback_first_token_ms,
 p.observed_until_ms AS primary_observed_until_ms,COALESCE(p.end_reason,CASE WHEN p.dispatched_at IS NULL THEN 'not_dispatched' WHEN r.request_received_at < statement_timestamp()-interval '110 seconds' THEN 'unknown' ELSE 'pending' END) AS primary_end_reason,
 f.end_reason AS fallback_end_reason,p.provider_latency_ms AS primary_provider_latency_ms,f.provider_latency_ms AS fallback_provider_latency_ms,
 p.first_token_ms-p.provider_latency_ms AS primary_provider_gap_ms,f.first_token_ms-f.provider_latency_ms AS fallback_provider_gap_ms,
 r.client_first_token_visible_ms-r.first_token_emitted_ms AS client_server_residual_ms,
 r.client_first_token_visible_ms-r.client_first_token_received_ms AS client_display_delay_ms,
 h.status AS business_status,h.llm_finish_reason AS business_finish_reason,r.fallback_model_id,r.fallback_timeout_ms,r.client_wait_finished_ms,r.server_timeout_stage,r.recoverable_delivery,r.server_first_token_ready_ms,r.client_delivery_failed
FROM experience.chat_generation_requests r
JOIN experience.chat_history h ON h.id=r.chat_history_id
LEFT JOIN experience.chat_generation_attempts p ON p.chat_history_id=r.chat_history_id AND p.role='primary'
LEFT JOIN experience.chat_generation_attempts f ON f.chat_history_id=r.chat_history_id AND f.role='fallback'
LEFT JOIN experience.chat_generation_attempts d ON d.id=r.delivery_attempt_id;

NOTIFY pgrst,'reload schema';
COMMIT;
