-- Domain: experience owns per-request timing facts; admin validates runtime configuration;
-- miniapp_analytics derives read-only facts. No content, data backfill or new grants.
-- Dependencies: 20261023_chat_first_token_fallback_config.sql (+ existing reader grants).
-- Apply TEST before production. Nullable additions preserve legacy semantics.
-- Rollback: retain facts/columns, restore compatible application and publish prior config.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
ALTER TABLE experience.chat_generation_requests
  ADD COLUMN IF NOT EXISTS fallback_timeout_ms integer CHECK (fallback_timeout_ms > 0 AND fallback_timeout_ms < first_token_deadline_ms),
  ADD COLUMN IF NOT EXISTS client_wait_finished_ms numeric CHECK (client_wait_finished_ms >= 0),
  ADD COLUMN IF NOT EXISTS server_timeout_stage text CHECK (server_timeout_stage IN ('global','primary','fallback'));
ALTER TABLE experience.chat_generation_attempts DROP CONSTRAINT IF EXISTS chat_generation_attempts_end_reason_check;
ALTER TABLE experience.chat_generation_attempts ADD CONSTRAINT chat_generation_attempts_end_reason_check
  CHECK (end_reason IN ('budget_skipped','first_token_observed','first_token_deadline','completed','upstream_error','cancelled','observation_deadline','stream_interrupted')) NOT VALID;
ALTER TABLE experience.chat_generation_attempts VALIDATE CONSTRAINT chat_generation_attempts_end_reason_check;
COMMENT ON COLUMN experience.chat_generation_requests.fallback_timeout_ms IS 'Configured fallback POST-to-first-token limit; NULL means legacy policy, not 2000ms.';
COMMENT ON COLUMN experience.chat_generation_requests.client_wait_finished_ms IS 'Client monotonic submit-to-observation-finish duration, including failures; NULL when unreported.';
CREATE OR REPLACE FUNCTION admin.validate_model_catalog_first_token(p_value jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v_deadline numeric := 10000; v_fallback_wait numeric := 2000; v_tier jsonb; v_model jsonb; v_wait numeric;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RETURN; END IF;
  IF p_value ? 'first_token_deadline_ms' THEN
    IF jsonb_typeof(p_value->'first_token_deadline_ms') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'first_token_deadline_ms must be an integer' USING ERRCODE='22023';
    END IF;
    v_deadline := (p_value->>'first_token_deadline_ms')::numeric;
  END IF;
  IF v_deadline <= 0 OR v_deadline > 110000 OR v_deadline <> trunc(v_deadline) THEN
    RAISE EXCEPTION 'invalid global first-token deadline' USING ERRCODE='22023';
  END IF;
  IF p_value ? 'fallback_timeout_ms' THEN
    IF jsonb_typeof(p_value->'fallback_timeout_ms') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'fallback_timeout_ms must be an integer' USING ERRCODE='22023';
    END IF;
    v_fallback_wait := (p_value->>'fallback_timeout_ms')::numeric;
  END IF;
  IF v_fallback_wait <= 0 OR v_fallback_wait <> trunc(v_fallback_wait) OR v_fallback_wait >= v_deadline THEN
    RAISE EXCEPTION 'fallback wait must be positive and below total deadline' USING ERRCODE='22023';
  END IF;
  IF p_value ? 'first_token_timeout_rate_target' THEN
    IF jsonb_typeof(p_value->'first_token_timeout_rate_target') IS DISTINCT FROM 'number'
       OR (p_value->>'first_token_timeout_rate_target')::numeric NOT BETWEEN 0 AND 1 THEN
      RAISE EXCEPTION 'timeout rate target must be a ratio in [0,1]' USING ERRCODE='22023';
    END IF;
  END IF;
  IF p_value ? 'fallback_model_id' THEN
    IF jsonb_typeof(p_value->'fallback_model_id') IS DISTINCT FROM 'string'
       OR length(p_value->>'fallback_model_id') > 200
       OR (p_value->>'fallback_model_id') !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
      RAISE EXCEPTION 'fallback_model_id must be an OpenRouter model ID' USING ERRCODE='22023';
    END IF;
  END IF;
  IF jsonb_typeof(p_value->'tiers') IS DISTINCT FROM 'array' THEN RETURN; END IF;
  FOR v_tier IN SELECT value FROM jsonb_array_elements(p_value->'tiers') LOOP
    IF jsonb_typeof(v_tier->'models') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    FOR v_model IN SELECT value FROM jsonb_array_elements(v_tier->'models') LOOP
      v_wait := 4000;
      IF v_model ? 'first_token_timeout_ms' THEN
        IF jsonb_typeof(v_model->'first_token_timeout_ms') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'first_token_timeout_ms must be an integer' USING ERRCODE='22023';
        END IF;
        v_wait := (v_model->>'first_token_timeout_ms')::numeric;
      END IF;
      IF v_wait <= 0 OR v_wait <> trunc(v_wait) OR v_wait >= v_deadline THEN
        RAISE EXCEPTION 'model first-token wait must be positive and below the global deadline' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

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
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='40001';
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
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms)
  VALUES(p_history_id,(p_input->>'request_id')::uuid,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer);
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$$;

CREATE OR REPLACE FUNCTION experience.report_chat_first_token(p_user_id uuid,p_session_id uuid,p_report jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text;
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
 h.status AS business_status,h.llm_finish_reason AS business_finish_reason,r.fallback_model_id,r.fallback_timeout_ms,r.client_wait_finished_ms,r.server_timeout_stage
FROM experience.chat_generation_requests r
JOIN experience.chat_history h ON h.id=r.chat_history_id
LEFT JOIN experience.chat_generation_attempts p ON p.chat_history_id=r.chat_history_id AND p.role='primary'
LEFT JOIN experience.chat_generation_attempts f ON f.chat_history_id=r.chat_history_id AND f.role='fallback'
LEFT JOIN experience.chat_generation_attempts d ON d.id=r.delivery_attempt_id;

CREATE OR REPLACE FUNCTION miniapp_analytics.chat_first_token_report(p_from timestamptz,p_to timestamptz)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
WITH facts AS (SELECT * FROM miniapp_analytics.chat_first_token_facts WHERE request_received_at >= p_from AND request_received_at < p_to AND p_to > p_from AND NOT billing_rejected),
totals AS (SELECT requested_model_id,count(*) AS model_requests FROM facts GROUP BY requested_model_id)
SELECT jsonb_build_object(
 'report_version',2,'from',p_from,'to',p_to,'model_id',f.requested_model_id,'provider',f.requested_provider,'provider_model_id',f.requested_provider_model_id,
 'fallback_model_id',f.fallback_model_id,'fallback_timeout_ms',f.fallback_timeout_ms,'measurement_method',f.measurement_method,
 'catalog_version',f.catalog_version,'primary_timeout_ms',f.primary_timeout_ms,'first_token_deadline_ms',f.first_token_deadline_ms,
 'timeout_rate_target',f.timeout_rate_target,'model_requests',t.model_requests,'sample_eligible',t.model_requests>=150,
 'send_requests',count(*) FILTER(WHERE mode='send'),'regenerate_requests',count(*) FILTER(WHERE mode='regenerate'),
 'requests',count(*),'fallback_started',count(*) FILTER(WHERE fallback_started),'fallback_start_rate',avg(fallback_started::integer),
 'fallback_selected',count(*) FILTER(WHERE delivery_role='fallback'),'fallback_selection_rate',avg((COALESCE(delivery_role,'')='fallback')::integer),
 'fallback_displayed',count(*) FILTER(WHERE delivery_role='fallback' AND client_outcome='observed'),
 'fallback_display_share_observed',count(*) FILTER(WHERE delivery_role='fallback' AND client_outcome='observed')::numeric/NULLIF(count(*) FILTER(WHERE client_outcome='observed'),0),
 'fallback_display_rate_lower_bound_all',count(*) FILTER(WHERE delivery_role='fallback' AND client_outcome='observed')::numeric/NULLIF(count(*),0),
 'client_reports',count(*) FILTER(WHERE client_outcome<>'missing'),'client_report_coverage',avg((client_outcome<>'missing')::integer),
 'visible_samples',count(client_first_token_visible_ms),'foreground_visible_samples',count(*) FILTER(WHERE client_outcome='observed' AND client_backgrounded=false),
 'user_first_token_p50_ms',percentile_cont(0.5) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE client_backgrounded=false),
 'user_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE client_backgrounded=false),
 'user_first_token_p95_ms',percentile_cont(0.95) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE client_backgrounded=false),
 'primary_display_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivery_role='primary' AND client_backgrounded=false),
 'fallback_display_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivery_role='fallback' AND client_backgrounded=false)
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
 'client_upstream_errors_without_display',count(*) FILTER(WHERE client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')),
 'foreground_first_token_failure_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome='timed_out' OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout'))))::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),0),
 'foreground_time_cutoff_samples',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome='timed_out' OR (client_outcome='not_observed' AND client_reason IN ('server_timeout','primary_timeout','fallback_timeout')))),
 'foreground_known_result_samples',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),
 'foreground_time_cutoff_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome='timed_out' OR (client_outcome='not_observed' AND client_reason IN ('server_timeout','primary_timeout','fallback_timeout'))))::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),0),
 'fallback_stage_failures',count(*) FILTER(WHERE server_timeout_stage='fallback'),
 'primary_stage_failures',count(*) FILTER(WHERE server_timeout_stage='primary'),
 'client_wait_finished_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_wait_finished_ms) FILTER(WHERE client_backgrounded=false),
 'server_timeouts',count(*) FILTER(WHERE server_first_token_timeout),'missing_client_reports',count(*) FILTER(WHERE client_outcome='missing'),
 'not_observed',count(*) FILTER(WHERE client_outcome='not_observed'),'cancelled',count(*) FILTER(WHERE business_finish_reason='cancelled'),
 'failed',count(*) FILTER(WHERE business_status IN ('failed','upstream_error','stream_interrupted')),
 'primary_exact_samples',count(primary_actual_first_token_ms),'primary_censored_or_unknown',count(*) FILTER(WHERE primary_actual_first_token_ms IS NULL),
 'fallback_exact_samples',count(fallback_first_token_ms)
)
FROM facts f JOIN totals t USING(requested_model_id)
GROUP BY f.requested_model_id,f.requested_provider,f.requested_provider_model_id,f.catalog_version,f.fallback_model_id,f.primary_timeout_ms,f.first_token_deadline_ms,f.timeout_rate_target,f.fallback_timeout_ms,f.measurement_method,t.model_requests;
$$;

DO $$
DECLARE v jsonb;
BEGIN
  FOR v IN SELECT value FROM app_core.runtime_config WHERE key='llm_model_catalog'
    UNION ALL SELECT value FROM admin.config_drafts WHERE config_key='llm_model_catalog' AND value IS NOT NULL
    UNION ALL SELECT value FROM admin.config_releases WHERE config_key='llm_model_catalog' AND value IS NOT NULL
  LOOP PERFORM admin.validate_model_catalog_first_token(v); END LOOP;
END;
$$;
NOTIFY pgrst, 'reload schema';

COMMIT;
