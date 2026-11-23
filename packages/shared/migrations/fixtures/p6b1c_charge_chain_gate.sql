-- Production billing.chat_delivery_billing_gate as of 11-21 (md5 e87217dd005870c5dd0635fa0289ee73, after #1066).
-- Test fixture only (scripts/test-db-reorg-p6b1c-charge-chain.sh); this PR does not change it.
CREATE OR REPLACE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r experience.chat_generation_requests%ROWTYPE; h experience.chat_history%ROWTYPE; v_snapshot jsonb;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0
  JOIN experience.chat_history h0 ON h0.id=r0.chat_history_id
  WHERE h0.llm_charge_id=p_charge_key FOR UPDATE OF r0;
  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
  -- db reorg 6b-1b: the frozen quote is read from billing.usage_charges, the row p_charge_key names.
  SELECT u.quote -> 'snapshot' INTO v_snapshot FROM billing.usage_charges u WHERE u.id = p_charge_key;
  IF r.recoverable_delivery THEN
    SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
    -- server-facts-delivery-v1: only a failure the server declared can waive a reply.
    -- client_delivery_failed now means a relayed server failure; older rows keep their waiver.
    IF r.client_delivery_failed OR r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
       OR h.llm_finish_reason='timeout'
      THEN RETURN 'waived'; END IF;
    IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
       AND v_snapshot->>'charge_id'=p_charge_key::text
       AND v_snapshot->>'billing_mode'='fixed_tier'
       AND jsonb_typeof(v_snapshot->'payable_credits')='number'
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
     AND v_snapshot->>'charge_id'=p_charge_key::text
     AND v_snapshot->>'billing_mode'='fixed_tier'
     AND jsonb_typeof(v_snapshot->'payable_credits')='number'
    THEN RETURN 'user_stopped'; END IF;
  IF r.client_outcome='observed' AND r.client_first_token_visible_ms IS NOT NULL
     AND r.client_first_token_visible_ms < r.first_token_deadline_ms THEN RETURN 'visible'; END IF;
  IF r.client_outcome IN ('timed_out','not_observed')
     OR clock_timestamp() >= r.request_received_at
       + make_interval(secs => r.first_token_deadline_ms::double precision / 1000 + 15)
    THEN RETURN 'waived'; END IF;
  RETURN 'pending';
END;
$function$
;
