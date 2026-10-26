-- domain: billing, experience
-- Explicit new user stops use the accepted quote/entitlement, even before visible text.
-- Legacy cancelled, upstream failures and deadline cutoffs keep their free policy.
-- One constant-default policy column (historical false, new requests true); no backfill/index.
-- TEST first; additive production migration -> backend -> explicit-reason frontend.
-- Recovery: stop new frontend intents; keep this reader for already persisted user stops.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE experience.chat_generation_requests
  ADD COLUMN IF NOT EXISTS user_stop_billing_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE experience.chat_generation_requests
  ALTER COLUMN user_stop_billing_enabled SET DEFAULT true;
COMMENT ON COLUMN experience.chat_generation_requests.user_stop_billing_enabled IS
  'Server-owned policy at request creation: historical cancellations stay free; new user stops use the frozen quote.';

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
  v_deadline := COALESCE(r.first_token_timeout,false)
    OR r.server_timeout_stage IN ('global','primary','fallback') OR
    (r.client_outcome IS DISTINCT FROM 'observed' AND clock_timestamp() >=
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

-- Narrow checked edits preserve the deployed price, wallet, dedup and locking rules.
DO $$
DECLARE d text; old text; new text;
BEGIN
  SELECT pg_get_functiondef('billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure) INTO d;
  IF position('user_stopped' IN d)=0 THEN
    old := '  v_delivery_gate TEXT;';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected charge declaration'; END IF;
    d := replace(d,old,old||E'\n  v_stop_snapshot JSONB;');
    old := '  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected delivery gate'; END IF;
    new := old||$patch$
  IF v_delivery_gate='user_stopped' THEN
    SELECT llm_billing_snapshot INTO v_stop_snapshot FROM experience.chat_history
      WHERE llm_charge_id=p_charge_key;
    -- The persisted accepted quote wins; no repricing from the current catalogue.
    v_metadata := v_metadata || v_stop_snapshot || jsonb_build_object(
      'billing_mode','fixed_tier','billing_trigger','user_stop',
      'chat_status','stream_interrupted','finish_reason','user_cancelled');
  END IF;$patch$;
    d := replace(d,old,new);
    old := E'    AND NOT v_waiting_finish\n    AND (v_chat_status <> ''success'' OR v_finish_reason <> ''stop'');';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected non-billable gate'; END IF;
    new := E'    AND NOT v_waiting_finish\n    AND v_delivery_gate <> ''user_stopped''\n    AND (v_chat_status <> ''success'' OR v_finish_reason <> ''stop'');';
    d := replace(d,old,new);
    old := E'  v_difference_reason := CASE\n';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected charge audit'; END IF;
    d := replace(d,old,old||E'    WHEN v_delivery_gate = ''user_stopped'' THEN ''user_stop''\n');
    EXECUTE d;
  END IF;

  SELECT pg_get_functiondef('billing.finalize_character_free_chat_round(uuid,boolean)'::regprocedure) INTO d;
  IF position('user_stopped' IN d)=0 THEN
    old := '  IF p_success AND v_delivery_gate = ''waived'' THEN p_success := false; END IF;';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected free-quota gate'; END IF;
    new := $patch$  IF v_delivery_gate='user_stopped' THEN
    -- A paid stop consumes its original free entitlement instead of bypassing it.
    p_success := true;
  ELSIF p_success AND v_delivery_gate='waived' THEN p_success := false; END IF;$patch$;
    d := replace(d,old,new);
    EXECUTE d;
  END IF;

  SELECT pg_get_functiondef('experience.report_chat_first_token(uuid,uuid,jsonb)'::regprocedure) INTO d;
  IF position('user-stop marker' IN d)=0 THEN
    old := '  IF r.requires_visible_token AND v_outcome IN (''timed_out'',''not_observed'') THEN';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected receipt quota release'; END IF;
    new := $patch$  -- A cancelled receipt may precede the server user-stop marker. Finalize there.
  IF r.requires_visible_token AND v_outcome IN ('timed_out','not_observed')
     AND COALESCE(p_report->>'reason','') <> 'cancelled' THEN$patch$;
    d := replace(d,old,new);
    EXECUTE d;
  END IF;
END;
$$;

DO $$
BEGIN
  IF has_function_privilege('anon','billing.chat_delivery_billing_gate(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','billing.chat_delivery_billing_gate(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected public billing gate privilege';
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
