-- Domain: billing delivery gate and experience receipt; replaces two existing functions only.
-- Server facts alone decide delivery billing: the browser's first-token clock includes the
-- user's own network, so it stays a measurement and no longer waives or releases anything.
-- No tables, grants, backfill, cron or per-turn reads/writes. TEST before production.
-- Rows already marked client_delivery_failed stay waived; settled rows are never reopened.
-- Rollback: re-run the gate from 20261027_recoverable_chat_delivery.sql and the receipt from
-- 20261029_first_token_receipt_recovery.sql. Replies charged meanwhile remain valid charges.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10s';
DO $migration$
DECLARE
  marker text := 'server-facts-delivery-v1';
  gate_sql text := pg_get_functiondef('billing.chat_delivery_billing_gate(uuid)'::regprocedure);
  report_sql text := pg_get_functiondef('experience.report_chat_first_token(uuid,uuid,jsonb)'::regprocedure);
  gate_old text := $old$    IF r.client_delivery_failed OR r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
       OR h.llm_finish_reason='timeout'
       OR (r.client_backgrounded=false AND r.client_reason IS DISTINCT FROM 'page_left' AND
         ((r.client_outcome='timed_out' AND (r.client_first_token_received_ms IS NULL OR r.client_first_token_received_ms >= r.first_token_deadline_ms))
           OR (r.client_outcome='observed' AND r.client_first_token_received_ms >= r.first_token_deadline_ms)))
      THEN RETURN 'waived'; END IF;$old$;
  gate_new text := $new$    -- server-facts-delivery-v1: only a failure the server declared can waive a reply.
    -- client_delivery_failed now means a relayed server failure; older rows keep their waiver.
    IF r.client_delivery_failed OR r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
       OR h.llm_finish_reason='timeout'
      THEN RETURN 'waived'; END IF;$new$;
  report_old text := $old$  -- Reception is a diagnostic stage, not delivery: a token received at 2s but
  -- committed at/after the frozen deadline is a foreground cutoff under v4.
  v_delivery_failed := COALESCE((r.recoverable_delivery AND (p_report->>'backgrounded')::boolean=false
    AND (v_reason IN ('server_timeout','primary_timeout','fallback_timeout')
      OR (v_outcome='timed_out' AND (v_v4 OR (p_report->>'first_token_received_ms')::numeric IS NULL
        OR (p_report->>'first_token_received_ms')::numeric >= r.first_token_deadline_ms)))),false);$old$;
  report_new text := $new$  -- server-facts-delivery-v1: a browser deadline stays a measurement. Only a relayed
  -- server failure marks delivery failed, which is what releases quota and waives billing.
  v_delivery_failed := COALESCE((r.recoverable_delivery AND (p_report->>'backgrounded')::boolean=false
    AND v_reason IN ('server_timeout','primary_timeout','fallback_timeout')),false);$new$;
BEGIN
  IF position(marker IN gate_sql) = 0 THEN
    IF cardinality(string_to_array(gate_sql, gate_old)) <> 2 THEN
      RAISE EXCEPTION 'chat_delivery_billing_gate source drifted; expected exactly one anchor';
    END IF;
    EXECUTE replace(gate_sql, gate_old, gate_new);
  END IF;
  IF position(marker IN report_sql) = 0 THEN
    IF cardinality(string_to_array(report_sql, report_old)) <> 2 THEN
      RAISE EXCEPTION 'report_chat_first_token source drifted; expected exactly one anchor';
    END IF;
    EXECUTE replace(report_sql, report_old, report_new);
  END IF;
END
$migration$;
COMMIT;
