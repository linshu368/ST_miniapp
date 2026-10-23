-- Domains: experience owns generation/attempt identities; admin validates configuration;
-- miniapp_analytics exposes derived first-token facts. Billing remains in its existing domain.
-- Additive only. Apply manually to TEST first; see the task design and ops guide.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION admin.validate_model_catalog_first_token(p_value jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v_deadline numeric := 6000; v_tier jsonb; v_model jsonb; v_wait numeric;
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
  IF p_value ? 'first_token_timeout_rate_target' THEN
    IF jsonb_typeof(p_value->'first_token_timeout_rate_target') IS DISTINCT FROM 'number'
       OR (p_value->>'first_token_timeout_rate_target')::numeric NOT BETWEEN 0 AND 1 THEN
      RAISE EXCEPTION 'timeout rate target must be a ratio in [0,1]' USING ERRCODE='22023';
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

-- Preserve the existing validator OIDs: old CHECKs/triggers must not remain attached to
-- a renamed validator that silently bypasses the new field checks.
DO $$
DECLARE v_name text; v_definition text; v_position integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['admin.validate_model_catalog_core(jsonb)', 'admin.validate_model_catalog_prd(jsonb)'] LOOP
    SELECT pg_get_functiondef(v_name::regprocedure) INTO v_definition;
    IF position('PERFORM admin.validate_model_catalog_first_token(p_value)' IN v_definition) = 0 THEN
      v_position := position('BEGIN' IN v_definition);
      IF v_position = 0 THEN RAISE EXCEPTION 'Unexpected model validator shape: %', v_name; END IF;
      EXECUTE overlay(v_definition PLACING E'BEGIN\n  PERFORM admin.validate_model_catalog_first_token(p_value);' FROM v_position FOR 5);
    END IF;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS experience.chat_generation_requests (
  chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('send','regenerate')),
  request_received_at timestamptz NOT NULL,
  requested_model_id text NOT NULL,
  requested_provider text NOT NULL CHECK (requested_provider IN ('openrouter','venice')),
  requested_provider_model_id text NOT NULL,
  catalog_version integer NOT NULL CHECK (catalog_version >= 0),
  primary_timeout_ms integer NOT NULL CHECK (primary_timeout_ms > 0),
  first_token_deadline_ms integer NOT NULL CHECK (first_token_deadline_ms > primary_timeout_ms AND first_token_deadline_ms <= 110000),
  timeout_rate_target numeric NOT NULL CHECK (timeout_rate_target BETWEEN 0 AND 1),
  fallback_model_id text NOT NULL DEFAULT 'deepseek/deepseek-v4.1-flash',
  fallback_triggered_ms numeric CHECK (fallback_triggered_ms >= 0),
  delivery_attempt_id uuid,
  first_token_emitted_ms numeric CHECK (first_token_emitted_ms >= 0),
  first_token_timeout boolean NOT NULL DEFAULT false,
  billing_rejected boolean NOT NULL DEFAULT false,
  client_outcome text NOT NULL DEFAULT 'missing' CHECK (client_outcome IN ('missing','observed','timed_out','not_observed')),
  client_first_token_visible_ms numeric CHECK (client_first_token_visible_ms >= 0),
  client_request_dispatched_ms numeric CHECK (client_request_dispatched_ms >= 0),
  client_first_token_received_ms numeric CHECK (client_first_token_received_ms >= 0),
  client_backgrounded boolean,
  measurement_method text,
  client_reason text,
  client_reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chat_generation_client_observation_check CHECK ((client_outcome='observed') = (client_first_token_visible_ms IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS chat_generation_requests_window_idx ON experience.chat_generation_requests(request_received_at, requested_model_id);
CREATE INDEX IF NOT EXISTS chat_generation_requests_client_idx ON experience.chat_generation_requests(client_request_id);

CREATE TABLE IF NOT EXISTS experience.chat_generation_attempts (
  id uuid PRIMARY KEY,
  chat_history_id uuid NOT NULL REFERENCES experience.chat_generation_requests(chat_history_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('primary','fallback')),
  provider text NOT NULL CHECK (provider IN ('openrouter','venice')),
  provider_model_id text NOT NULL,
  generation_id text,
  dispatched_at timestamptz,
  dispatch_offset_ms numeric CHECK (dispatch_offset_ms >= 0),
  headers_ms numeric CHECK (headers_ms >= 0),
  first_chunk_ms numeric CHECK (first_chunk_ms >= 0),
  first_token_ms numeric CHECK (first_token_ms >= 0),
  observed_until_ms numeric CHECK (observed_until_ms >= 0),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  end_reason text CHECK (end_reason IN ('first_token_observed','first_token_deadline','completed','upstream_error','cancelled','observation_deadline','stream_interrupted')),
  provider_latency_ms numeric CHECK (provider_latency_ms >= 0),
  provider_latency_scope text NOT NULL DEFAULT 'provider_defined_including_reasoning',
  provider_name text,
  provider_reported_model text,
  finish_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chat_generation_attempt_role_unique UNIQUE (chat_history_id, role),
  CONSTRAINT chat_generation_attempt_parent_unique UNIQUE (chat_history_id, id)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='experience.chat_generation_requests'::regclass AND conname='chat_generation_delivery_fk') THEN
    ALTER TABLE experience.chat_generation_requests ADD CONSTRAINT chat_generation_delivery_fk
      FOREIGN KEY (chat_history_id, delivery_attempt_id) REFERENCES experience.chat_generation_attempts(chat_history_id,id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
COMMENT ON TABLE experience.chat_generation_requests IS 'One accepted generation revision; client display facts are observations, not billing authority.';
COMMENT ON TABLE experience.chat_generation_attempts IS 'At most primary/fallback; observed/censored call facts. Observer attempts never enter billing sync.';
COMMENT ON COLUMN experience.chat_generation_attempts.first_token_ms IS 'Exact backend content-token TTFT in milliseconds; NULL means not observed, not zero.';
COMMENT ON COLUMN experience.chat_generation_attempts.provider_latency_ms IS 'Provider-reported milliseconds; can include reasoning-first semantics, never client display time.';
ALTER TABLE experience.chat_generation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.chat_generation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_generation_requests, experience.chat_generation_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON experience.chat_generation_requests, experience.chat_generation_attempts TO service_role;

CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL
     OR (p_input ? 'snapshot' AND h.llm_charge_id::text IS DISTINCT FROM p_input#>>'{snapshot,charge_id}') THEN
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='40001';
  END IF;
  IF p_input ? 'snapshot' THEN
    UPDATE experience.chat_history SET llm_billing_snapshot=p_input->'snapshot' WHERE id=p_history_id;
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN
    IF NOT EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id AND client_request_id=(p_input->>'request_id')::uuid) THEN
      RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target)
  VALUES(p_history_id,(p_input->>'request_id')::uuid,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric);
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$$;

CREATE OR REPLACE FUNCTION experience.prepare_chat_generation_fallback(p_history_id uuid,p_attempt_id uuid,p_triggered_ms numeric)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL THEN RAISE EXCEPTION 'Generation already ended' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id AND delivery_attempt_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Delivery has already been chosen' USING ERRCODE='40001';
  END IF;
  UPDATE experience.chat_generation_requests SET fallback_triggered_ms=COALESCE(fallback_triggered_ms,p_triggered_ms) WHERE chat_history_id=p_history_id;
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES(p_attempt_id,p_history_id,'fallback','openrouter','deepseek/deepseek-v4.1-flash')
  ON CONFLICT(chat_history_id,role) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM experience.chat_generation_attempts WHERE id=p_attempt_id AND chat_history_id=p_history_id AND role='fallback') THEN
    RAISE EXCEPTION 'Fallback attempt identity conflict' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION experience.observe_chat_generation_attempt(p_history_id uuid,p_observation jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a experience.chat_generation_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=(p_observation->>'id')::uuid AND chat_history_id=p_history_id FOR UPDATE;
  IF a.provider IS DISTINCT FROM p_observation->>'provider' OR a.provider_model_id IS DISTINCT FROM p_observation->>'model' OR a.role IS DISTINCT FROM p_observation->>'role' THEN
    RAISE EXCEPTION 'Attempt route cannot be rebound' USING ERRCODE='22023';
  END IF;
  IF a.generation_id IS NOT NULL AND p_observation->>'generation_id' IS NOT NULL AND a.generation_id <> p_observation->>'generation_id' THEN
    RAISE EXCEPTION 'Attempt generation identity conflict' USING ERRCODE='22023';
  END IF;
  UPDATE experience.chat_generation_attempts SET
    generation_id=COALESCE(generation_id,p_observation->>'generation_id'),
    dispatched_at=COALESCE(dispatched_at,(p_observation->>'dispatched_at')::timestamptz),
    dispatch_offset_ms=COALESCE(dispatch_offset_ms,(p_observation->>'dispatch_offset_ms')::numeric),
    headers_ms=COALESCE(headers_ms,(p_observation->>'headers_ms')::numeric),
    first_chunk_ms=COALESCE(first_chunk_ms,(p_observation->>'first_chunk_ms')::numeric),
    first_token_ms=COALESCE(first_token_ms,(p_observation->>'first_token_ms')::numeric),
    observed_until_ms=GREATEST(observed_until_ms,(p_observation->>'observed_until_ms')::numeric),
    http_status=COALESCE(http_status,(p_observation->>'http_status')::integer),
    end_reason=COALESCE(end_reason,p_observation->>'end_reason'),
    provider_latency_ms=COALESCE(provider_latency_ms,(p_observation->>'provider_latency_ms')::numeric),
    provider_name=COALESCE(provider_name,left(p_observation->>'provider_name',512)),
    provider_reported_model=COALESCE(provider_reported_model,left(p_observation->>'provider_reported_model',512)),
    finish_reason=COALESCE(finish_reason,left(p_observation->>'finish_reason',128)),updated_at=clock_timestamp()
  WHERE id=a.id;
END;
$$;

CREATE OR REPLACE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid,p_attempt_id uuid,p_generation_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE; r experience.chat_generation_requests%ROWTYPE; a experience.chat_generation_attempts%ROWTYPE; v_existing text;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=p_attempt_id AND chat_history_id=p_history_id FOR UPDATE;
  IF r.fallback_triggered_ms IS NOT NULL AND a.role <> 'fallback' THEN
    RAISE EXCEPTION 'Primary cannot reclaim delivery after fallback' USING ERRCODE='40001';
  END IF;
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  IF r.delivery_attempt_id IS NOT NULL THEN
    IF r.delivery_attempt_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Delivery already belongs to another attempt' USING ERRCODE='40001';
  END IF;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL OR h.llm_billing_snapshot->>'charge_id' IS DISTINCT FROM h.llm_charge_id::text THEN
    RAISE EXCEPTION 'Cancelled/ended generation cannot choose delivery' USING ERRCODE='40001';
  END IF;
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  IF a.provider='openrouter' THEN
    IF EXISTS(SELECT 1 FROM experience.venice_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;
    SELECT llm_generation_id INTO v_existing FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id;
    IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM COALESCE(p_generation_id,a.generation_id) THEN RAISE EXCEPTION 'Provider identity conflict'; END IF;
    INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_id)
    VALUES(p_history_id,COALESCE(p_generation_id,a.generation_id)) ON CONFLICT(chat_history_id)
    DO UPDATE SET llm_generation_id=COALESCE(experience.openrouter_chat_history.llm_generation_id,EXCLUDED.llm_generation_id);
  ELSE
    IF EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;
    SELECT llm_generation_id INTO v_existing FROM experience.venice_chat_history WHERE chat_history_id=p_history_id;
    IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM COALESCE(p_generation_id,a.generation_id) THEN RAISE EXCEPTION 'Provider identity conflict'; END IF;
    INSERT INTO experience.venice_chat_history(chat_history_id,llm_generation_id)
    VALUES(p_history_id,COALESCE(p_generation_id,a.generation_id)) ON CONFLICT(chat_history_id)
    DO UPDATE SET llm_generation_id=COALESCE(experience.venice_chat_history.llm_generation_id,EXCLUDED.llm_generation_id);
  END IF;
  -- The entire quote stays intact; only these two routing fields are bound to delivery.
  UPDATE experience.chat_history SET llm_billing_snapshot=llm_billing_snapshot || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id) WHERE id=p_history_id;
  UPDATE experience.chat_generation_attempts SET generation_id=COALESCE(generation_id,p_generation_id) WHERE id=p_attempt_id;
  UPDATE experience.chat_generation_requests SET delivery_attempt_id=p_attempt_id WHERE chat_history_id=p_history_id;
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
    client_reason=p_report->>'reason',client_reported_at=clock_timestamp()
  WHERE chat_history_id=r.chat_history_id;
  RETURN true;
END;
$$;

CREATE SCHEMA IF NOT EXISTS miniapp_analytics;
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
 h.status AS business_status,h.llm_finish_reason AS business_finish_reason
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
 'report_version',1,'from',p_from,'to',p_to,'model_id',f.requested_model_id,'provider',f.requested_provider,'provider_model_id',f.requested_provider_model_id,
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
 'client_upstream_errors_without_display',count(*) FILTER(WHERE client_outcome='not_observed' AND client_reason='upstream_error'),
 'foreground_first_token_failure_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome='timed_out' OR (client_outcome='not_observed' AND client_reason='upstream_error')))::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason='upstream_error'))),0),
 'server_timeouts',count(*) FILTER(WHERE server_first_token_timeout),'missing_client_reports',count(*) FILTER(WHERE client_outcome='missing'),
 'not_observed',count(*) FILTER(WHERE client_outcome='not_observed'),'cancelled',count(*) FILTER(WHERE business_finish_reason='cancelled'),
 'failed',count(*) FILTER(WHERE business_status IN ('failed','upstream_error','stream_interrupted')),
 'primary_exact_samples',count(primary_actual_first_token_ms),'primary_censored_or_unknown',count(*) FILTER(WHERE primary_actual_first_token_ms IS NULL),
 'fallback_exact_samples',count(fallback_first_token_ms)
)
FROM facts f JOIN totals t USING(requested_model_id)
GROUP BY f.requested_model_id,f.requested_provider,f.requested_provider_model_id,f.catalog_version,f.primary_timeout_ms,f.first_token_deadline_ms,f.timeout_rate_target,t.model_requests;
$$;

REVOKE ALL ON FUNCTION admin.validate_model_catalog_first_token(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION admin.validate_model_catalog_first_token(jsonb) TO service_role;
REVOKE ALL ON miniapp_analytics.chat_first_token_facts FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA miniapp_analytics TO service_role;
GRANT SELECT ON miniapp_analytics.chat_first_token_facts TO service_role;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='experience' AND p.proname IN ('begin_chat_generation_observation','prepare_chat_generation_fallback','observe_chat_generation_attempt','select_chat_generation_delivery','report_chat_first_token'))
       OR (n.nspname='miniapp_analytics' AND p.proname='chat_first_token_report') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.fn);
  END LOOP;
END $$;
DO $$ DECLARE v jsonb; BEGIN
  FOR v IN SELECT value FROM app_core.runtime_config WHERE key='llm_model_catalog'
    UNION ALL SELECT value FROM admin.config_drafts WHERE config_key='llm_model_catalog' AND value IS NOT NULL
    UNION ALL SELECT value FROM admin.config_releases WHERE config_key='llm_model_catalog' AND value IS NOT NULL
  LOOP PERFORM admin.validate_model_catalog_first_token(v); END LOOP;
END $$;
COMMIT;
