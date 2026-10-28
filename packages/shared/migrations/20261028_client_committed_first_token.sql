-- domain: experience owns one terminal client delivery receipt; miniapp_analytics owns read-only reporting.
-- Prerequisite: 20261027_recoverable_chat_delivery.sql. No backfill, tables, jobs, or ACL changes.
-- Deploy TEST then production migration -> backend (optional request method) -> v4 frontend/Grafana.
-- Restore compatible applications/legacy dashboard selection on rollback; retain v4 facts and use forward-fix.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE; v_fallback text := COALESCE(p_input->>'fallback_model_id','deepseek/deepseek-v4.1-flash');
BEGIN
  IF (p_input ? 'fallback_model_id' AND jsonb_typeof(p_input->'fallback_model_id') IS DISTINCT FROM 'string')
     OR length(v_fallback) > 200
     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Invalid frozen fallback model ID' USING ERRCODE='22023';
  END IF;
  IF p_input->>'measurement_method' IS NOT NULL AND p_input->>'measurement_method' <> 'client_committed_v4' THEN
    RAISE EXCEPTION 'Invalid client measurement method' USING ERRCODE='22023';
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
    IF NOT EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id AND client_request_id=(p_input->>'request_id')::uuid AND (NOT (p_input ? 'fallback_model_id') OR fallback_model_id=v_fallback) AND fallback_timeout_ms IS NOT DISTINCT FROM (p_input->>'fallback_timeout_ms')::integer AND (p_input->>'measurement_method' IS NULL OR measurement_method=p_input->>'measurement_method')) THEN
      RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms,recoverable_delivery,measurement_method)
  VALUES(p_history_id,(p_input->>'request_id')::uuid,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer,COALESCE((p_input->>'recoverable_delivery')::boolean,false),p_input->>'measurement_method');
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$$;


CREATE OR REPLACE FUNCTION experience.report_chat_first_token(p_user_id uuid,p_session_id uuid,p_report jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text; v_reason text; v_charge_id uuid;
  v_v4 boolean := COALESCE(p_report->>'measurement_method'='client_committed_v4',false);
  v_delivery_failed boolean;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0 JOIN experience.chat_history h ON h.id=r0.chat_history_id
  WHERE h.id=(p_report->>'assistant_message_id')::uuid AND h.user_id=p_user_id AND h.session_id=p_session_id
    AND h.revision=(p_report->>'revision')::integer AND r0.client_request_id=(p_report->>'request_id')::uuid FOR UPDATE OF r0;
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
  -- committed at/after 10s is a foreground cutoff under v4.
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

CREATE OR REPLACE FUNCTION miniapp_analytics.chat_first_token_report(p_from timestamptz,p_to timestamptz)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
WITH facts AS (SELECT *, CASE WHEN measurement_method='client_committed_v4' THEN 'client_committed_v4' ELSE 'legacy' END AS measurement_cohort,
 (client_outcome='observed' AND (measurement_method IS DISTINCT FROM 'client_committed_v4' OR client_first_token_visible_ms < first_token_deadline_ms)) AS delivered,
 ((recoverable_delivery AND client_delivery_failed) OR (NOT recoverable_delivery AND client_outcome='timed_out') OR (client_outcome='not_observed' AND client_reason IN ('server_timeout','primary_timeout','fallback_timeout'))) AS time_cutoff FROM miniapp_analytics.chat_first_token_facts WHERE request_received_at >= p_from AND request_received_at < p_to AND p_to > p_from AND NOT billing_rejected),
totals AS (SELECT requested_model_id,measurement_cohort,count(*) AS model_requests FROM facts GROUP BY requested_model_id,measurement_cohort)
SELECT jsonb_build_object(
 'report_version',3,'from',p_from,'to',p_to,'model_id',f.requested_model_id,'provider',f.requested_provider,'provider_model_id',f.requested_provider_model_id,
 'fallback_model_id',f.fallback_model_id,'fallback_timeout_ms',f.fallback_timeout_ms,'measurement_method',f.measurement_method,
 'recoverable_delivery',f.recoverable_delivery,'catalog_version',f.catalog_version,'primary_timeout_ms',f.primary_timeout_ms,'first_token_deadline_ms',f.first_token_deadline_ms,
 'timeout_rate_target',f.timeout_rate_target,'model_requests',t.model_requests,'sample_eligible',t.model_requests>=150,
 'send_requests',count(*) FILTER(WHERE mode='send'),'regenerate_requests',count(*) FILTER(WHERE mode='regenerate'),
 'requests',count(*),'fallback_started',count(*) FILTER(WHERE fallback_started),'fallback_start_rate',avg(fallback_started::integer),
 'fallback_selected',count(*) FILTER(WHERE delivery_role='fallback'),'fallback_selection_rate',avg((COALESCE(delivery_role,'')='fallback')::integer),
 'fallback_displayed',count(*) FILTER(WHERE delivery_role='fallback' AND delivered),
 'fallback_display_share_observed',count(*) FILTER(WHERE delivery_role='fallback' AND delivered)::numeric/NULLIF(count(*) FILTER(WHERE delivered),0),
 'fallback_display_rate_lower_bound_all',count(*) FILTER(WHERE delivery_role='fallback' AND delivered)::numeric/NULLIF(count(*),0),
 'client_reports',count(*) FILTER(WHERE client_outcome<>'missing'),'client_report_coverage',avg((client_outcome<>'missing')::integer),
 'visible_samples',count(*) FILTER(WHERE delivered),'foreground_visible_samples',count(*) FILTER(WHERE delivered AND client_backgrounded=false),
 'user_first_token_p50_ms',percentile_cont(0.5) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND client_backgrounded=false),
 'user_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND client_backgrounded=false),
 'user_first_token_p95_ms',percentile_cont(0.95) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND client_backgrounded=false),
 'primary_display_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND delivery_role='primary' AND client_backgrounded=false),
 'fallback_display_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND delivery_role='fallback' AND client_backgrounded=false)
) || jsonb_build_object(
 'preparation_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_dispatch_offset_ms),
 'fallback_dispatch_delay_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_dispatch_delay_ms),
 'client_display_delay_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_display_delay_ms) FILTER(WHERE client_backgrounded=false),
 'primary_headers_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_headers_ms),
 'fallback_headers_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_headers_ms),
 'primary_provider_latency_samples',count(primary_provider_latency_ms),'fallback_provider_latency_samples',count(fallback_provider_latency_ms),
 'primary_provider_gap_samples',count(primary_provider_gap_ms),'fallback_provider_gap_samples',count(fallback_provider_gap_ms),
 'primary_wait_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_wait_ms),
 'fallback_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_first_token_ms),
 'primary_actual_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_actual_first_token_ms),
 'replaced_primary_later_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_actual_first_token_ms) FILTER(WHERE fallback_started),
 'primary_provider_gap_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_provider_gap_ms),
 'fallback_provider_gap_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_provider_gap_ms),
 'client_server_residual_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_server_residual_ms) FILTER(WHERE client_backgrounded=false)
) || jsonb_build_object(
 'client_timeouts',count(*) FILTER(WHERE client_outcome='timed_out'),
 'client_timeout_rate_lower_bound_all',avg((client_outcome='timed_out')::integer),
 'foreground_timeout_rate_observed',count(*) FILTER(WHERE client_outcome='timed_out' AND client_backgrounded=false)::numeric / NULLIF(count(*) FILTER(WHERE client_outcome IN ('observed','timed_out') AND client_backgrounded=false),0),
 'foreground_deadline_samples',count(*) FILTER(WHERE client_outcome IN ('observed','timed_out') AND client_backgrounded=false),
 'backgrounded_requests',count(*) FILTER(WHERE client_backgrounded=true),
 'page_left_requests',count(*) FILTER(WHERE client_reason='page_left'),
 'client_upstream_errors_without_display',count(*) FILTER(WHERE client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')),
 'foreground_first_token_failure_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome='timed_out' OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout'))))::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),0),
 'foreground_time_cutoff_samples',count(*) FILTER(WHERE client_backgrounded=false AND time_cutoff),
 'foreground_known_result_samples',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),
 'foreground_time_cutoff_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND time_cutoff)::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),0),
 'fallback_stage_failures',count(*) FILTER(WHERE server_timeout_stage='fallback'),
 'primary_stage_failures',count(*) FILTER(WHERE server_timeout_stage='primary'),
 'client_wait_finished_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_wait_finished_ms) FILTER(WHERE client_backgrounded=false),
 'server_timeouts',count(*) FILTER(WHERE server_first_token_timeout),'missing_client_reports',count(*) FILTER(WHERE client_outcome='missing'),
 'not_observed',count(*) FILTER(WHERE client_outcome='not_observed'),'cancelled',count(*) FILTER(WHERE business_finish_reason='cancelled'),
 'failed',count(*) FILTER(WHERE business_status IN ('failed','upstream_error','stream_interrupted')),
 'primary_exact_samples',count(primary_actual_first_token_ms),'primary_censored_or_unknown',count(*) FILTER(WHERE primary_actual_first_token_ms IS NULL),
 'fallback_exact_samples',count(fallback_first_token_ms)
)
FROM facts f JOIN totals t USING(requested_model_id,measurement_cohort)
GROUP BY f.requested_model_id,f.requested_provider,f.requested_provider_model_id,f.catalog_version,f.fallback_model_id,f.primary_timeout_ms,f.first_token_deadline_ms,f.timeout_rate_target,f.fallback_timeout_ms,f.measurement_method,f.recoverable_delivery,t.model_requests;
$$;

COMMENT ON COLUMN experience.chat_generation_requests.measurement_method IS 'Client measurement contract, advertised when accepted for v4 and confirmed by the terminal receipt. Historical rows are not relabeled.';
COMMENT ON COLUMN experience.chat_generation_requests.client_first_token_visible_ms IS 'Milliseconds from client submit: v4 first displayable token committed to message UI; v1-v3 legacy viewport/display observation. NULL without successful first-token delivery.';
NOTIFY pgrst, 'reload schema';
COMMIT;
