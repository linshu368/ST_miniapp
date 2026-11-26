-- Fixture for scripts/test-free-zone-surplus-fallback-chain.sh. Disposable PG17 only, no real data.
-- Tables: the 2026-11-26 production shape of chat_generation_requests / chat_generation_attempts (columns + checks + keys);
-- other tables carry only the columns the chain reads. Functions: production bodies (md5 checked by the script).
DROP SCHEMA IF EXISTS experience, billing, ops CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA billing; CREATE SCHEMA ops;
GRANT USAGE ON SCHEMA experience TO service_role, anon;

CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid, turn_index integer, revision integer,
  status text NOT NULL, llm_finish_reason text, llm_charge_id uuid);
CREATE TABLE experience.chat_history_display_metadata (
  history_id uuid PRIMARY KEY, request_id text, opening_message text);
CREATE TABLE billing.usage_charges (id uuid PRIMARY KEY, quote jsonb NOT NULL DEFAULT '{}', updated_at timestamptz);
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY, attempt_id uuid, chat_history_id uuid NOT NULL, provider text NOT NULL, model text,
  generation_id text, discarded_detail jsonb, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid NOT NULL,
  client_request_id uuid NOT NULL,
  mode text NOT NULL,
  request_received_at timestamp with time zone NOT NULL,
  requested_model_id text NOT NULL,
  requested_provider text NOT NULL,
  requested_provider_model_id text NOT NULL,
  catalog_version integer NOT NULL,
  primary_timeout_ms integer NOT NULL,
  first_token_deadline_ms integer NOT NULL,
  timeout_rate_target numeric NOT NULL,
  fallback_model_id text NOT NULL DEFAULT 'deepseek/deepseek-v4.1-flash'::text,
  fallback_triggered_ms numeric,
  delivery_attempt_id uuid,
  first_token_timeout boolean NOT NULL DEFAULT false,
  billing_rejected boolean NOT NULL DEFAULT false,
  client_outcome text NOT NULL DEFAULT 'missing'::text,
  client_first_token_visible_ms numeric,
  measurement_method text,
  client_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  fallback_timeout_ms integer,
  server_timeout_stage text,
  requires_visible_token boolean NOT NULL DEFAULT true,
  user_stop_billing_enabled boolean NOT NULL DEFAULT true,
  recoverable_delivery boolean NOT NULL DEFAULT false,
  client_delivery_failed boolean NOT NULL DEFAULT false,
  server_first_token_ready_ms numeric,
  first_token_preview jsonb,
  CONSTRAINT chat_generation_client_observation_check CHECK (((client_outcome = 'observed'::text) = (client_first_token_visible_ms IS NOT NULL))),
  CONSTRAINT chat_generation_requests_catalog_version_check CHECK ((catalog_version >= 0)),
  CONSTRAINT chat_generation_requests_check CHECK (((first_token_deadline_ms > primary_timeout_ms) AND (first_token_deadline_ms <= 110000))),
  CONSTRAINT chat_generation_requests_check1 CHECK (((fallback_timeout_ms > 0) AND (fallback_timeout_ms < first_token_deadline_ms))),
  CONSTRAINT chat_generation_requests_client_first_token_visible_ms_check CHECK ((client_first_token_visible_ms >= (0)::numeric)),
  CONSTRAINT chat_generation_requests_client_outcome_check CHECK ((client_outcome = ANY (ARRAY['missing'::text, 'observed'::text, 'timed_out'::text, 'not_observed'::text]))),
  CONSTRAINT chat_generation_requests_fallback_triggered_ms_check CHECK ((fallback_triggered_ms >= (0)::numeric)),
  CONSTRAINT chat_generation_requests_first_token_preview_check CHECK (((first_token_preview IS NULL) OR ((jsonb_typeof(first_token_preview) = 'object'::text) AND ((first_token_preview ->> 'kind'::text) = ANY (ARRAY['delta'::text, 'reasoning'::text])) AND (jsonb_typeof((first_token_preview -> 'text'::text)) = 'string'::text)))),
  CONSTRAINT chat_generation_requests_mode_check CHECK ((mode = ANY (ARRAY['send'::text, 'regenerate'::text]))),
  CONSTRAINT chat_generation_requests_pkey PRIMARY KEY (chat_history_id),
  CONSTRAINT chat_generation_requests_primary_timeout_ms_check CHECK ((primary_timeout_ms > 0)),
  CONSTRAINT chat_generation_requests_requested_provider_check CHECK ((requested_provider = ANY (ARRAY['openrouter'::text, 'venice'::text, 'surplus'::text, 'packy'::text, 'onexmodel'::text]))),
  CONSTRAINT chat_generation_requests_server_first_token_ready_ms_check CHECK ((server_first_token_ready_ms >= (0)::numeric)),
  CONSTRAINT chat_generation_requests_server_timeout_stage_check CHECK ((server_timeout_stage = ANY (ARRAY['global'::text, 'primary'::text, 'fallback'::text]))),
  CONSTRAINT chat_generation_requests_timeout_rate_target_check CHECK (((timeout_rate_target >= (0)::numeric) AND (timeout_rate_target <= (1)::numeric))),
  FOREIGN KEY (chat_history_id) REFERENCES experience.chat_history(id) ON DELETE CASCADE);
CREATE TABLE experience.chat_generation_attempts (
  id uuid NOT NULL,
  chat_history_id uuid NOT NULL,
  role text NOT NULL,
  provider text NOT NULL,
  provider_model_id text NOT NULL,
  generation_id text,
  dispatched_at timestamp with time zone,
  dispatch_offset_ms numeric,
  first_token_ms numeric,
  observed_until_ms numeric,
  end_reason text,
  finish_reason text,
  updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chat_generation_attempt_parent_unique UNIQUE (chat_history_id, id),
  CONSTRAINT chat_generation_attempt_role_unique UNIQUE (chat_history_id, role),
  CONSTRAINT chat_generation_attempts_dispatch_offset_ms_check CHECK ((dispatch_offset_ms >= (0)::numeric)),
  CONSTRAINT chat_generation_attempts_end_reason_check CHECK ((end_reason = ANY (ARRAY['budget_skipped'::text, 'first_token_observed'::text, 'first_token_deadline'::text, 'completed'::text, 'upstream_error'::text, 'cancelled'::text, 'observation_deadline'::text, 'stream_interrupted'::text]))),
  CONSTRAINT chat_generation_attempts_first_token_ms_check CHECK ((first_token_ms >= (0)::numeric)),
  CONSTRAINT chat_generation_attempts_observed_until_ms_check CHECK ((observed_until_ms >= (0)::numeric)),
  CONSTRAINT chat_generation_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT chat_generation_attempts_provider_check CHECK ((provider = ANY (ARRAY['openrouter'::text, 'venice'::text, 'surplus'::text, 'packy'::text, 'onexmodel'::text]))),
  CONSTRAINT chat_generation_attempts_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'fallback'::text]))),
  FOREIGN KEY (chat_history_id) REFERENCES experience.chat_generation_requests(chat_history_id) ON DELETE CASCADE);
ALTER TABLE experience.chat_generation_requests ADD CONSTRAINT chat_generation_delivery_fk
  FOREIGN KEY (chat_history_id, delivery_attempt_id) REFERENCES experience.chat_generation_attempts(chat_history_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- stubs (not involved in the fallback route): quote save, wallet reservation, display projection, Surplus call row
CREATE TABLE experience.surplus_row_writes (history_id uuid, generation_id text);
CREATE FUNCTION billing.save_chat_turn_quote(p_history_id uuid, p_snapshot jsonb) RETURNS void LANGUAGE sql AS $f$
  UPDATE billing.usage_charges u SET quote = jsonb_build_object('snapshot', p_snapshot)
  FROM experience.chat_history h WHERE h.id = p_history_id AND u.id = h.llm_charge_id $f$;
CREATE FUNCTION billing.reserve_chat_charge(p_history_id uuid) RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION experience.extract_chat_history_display(p jsonb) RETURNS TABLE(request_id text, opening_message text)
  LANGUAGE sql AS $f$ SELECT p#>>'{0,request_id}', NULL::text $f$;
CREATE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p jsonb) RETURNS void
  LANGUAGE sql AS $f$ INSERT INTO experience.surplus_row_writes VALUES (p_history_id, p->>'generation_id') $f$;

-- production body (2026-11-26, md5 a2827dea57ffca6f95d0a82d15c79753)
CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  h experience.chat_history%ROWTYPE;
  v_fallback text := COALESCE(p_input->>'fallback_model_id','deepseek/deepseek-v4.1-flash');
  v_charge_id uuid := (p_input->>'charge_id')::uuid;
  v_request_id uuid := (p_input->>'request_id')::uuid;
  v_history jsonb := p_input->'history';
BEGIN
  IF (p_input ? 'fallback_model_id' AND jsonb_typeof(p_input->'fallback_model_id') IS DISTINCT FROM 'string')
     OR length(v_fallback) > 200
     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Invalid frozen fallback model ID' USING ERRCODE='22023';
  END IF;
  IF p_input->>'measurement_method' IS NOT NULL AND p_input->>'measurement_method' <> 'client_committed_v4' THEN
    RAISE EXCEPTION 'Invalid client measurement method' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'charge_id' AND v_charge_id IS NULL THEN
    RAISE EXCEPTION 'Invalid generation charge identity' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'history' THEN
    IF jsonb_typeof(v_history) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid generation history' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(v_history) = 0 OR v_request_id IS NULL
       OR (v_history#>>'{0,request_id}')::uuid IS DISTINCT FROM v_request_id
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_history) AS item
         WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR COALESCE(item->>'role','') NOT IN ('system','user','assistant')
           OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string'
       ) THEN
      RAISE EXCEPTION 'Generation history identity or message shape differs' USING ERRCODE='22023';
    END IF;
  END IF;

  IF p_input ? 'history' AND NOT (p_input ? 'snapshot')
     AND (jsonb_array_length(v_history) <> 1 OR v_history#>>'{0,role}' <> 'system' OR v_history#>>'{0,content}' <> '') THEN
    RAISE EXCEPTION 'Initial generation history must contain only its request marker' USING ERRCODE='22023';
  END IF;

  -- One PK row lock arbitrates admission/freeze against cancellation and terminal writes.
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL
     OR (v_charge_id IS NOT NULL AND h.llm_charge_id IS NOT NULL AND h.llm_charge_id <> v_charge_id)
     OR (p_input ? 'snapshot' AND COALESCE(h.llm_charge_id,v_charge_id)::text IS DISTINCT FROM p_input#>>'{snapshot,charge_id}') THEN
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='PT409';
  END IF;
  IF p_input ? 'history' AND EXISTS (
       SELECT 1 FROM experience.chat_history_display_metadata m
       WHERE m.history_id=p_history_id AND m.request_id IS NOT NULL
         AND m.request_id::uuid IS DISTINCT FROM v_request_id) THEN
    RAISE EXCEPTION 'Stored generation request identity differs' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id)
     AND NOT EXISTS (
       SELECT 1 FROM experience.chat_generation_requests
       WHERE chat_history_id=p_history_id AND client_request_id=v_request_id
         AND (NOT (p_input ? 'fallback_model_id') OR fallback_model_id=v_fallback)
         AND fallback_timeout_ms IS NOT DISTINCT FROM (p_input->>'fallback_timeout_ms')::integer
         AND (p_input->>'measurement_method' IS NULL OR measurement_method=p_input->>'measurement_method')
     ) THEN
    RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
  END IF;

  IF p_input ? 'history' OR v_charge_id IS NOT NULL OR p_input ? 'snapshot' THEN
    -- chat_display_projection_v1
    IF p_input ? 'history' AND (p_input ? 'snapshot' OR NOT EXISTS (SELECT 1 FROM billing.usage_charges u WHERE u.id=h.llm_charge_id AND u.quote ? 'snapshot')) THEN
      UPDATE experience.chat_history SET
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id)
      WHERE id=p_history_id;
      -- db reorg 6b-1c: the frozen quote lives in billing.usage_charges.quote.snapshot.
      IF p_input ? 'snapshot' THEN PERFORM billing.save_chat_turn_quote(p_history_id,p_input->'snapshot'); END IF;
      -- Derive only from the input actually accepted above, never from the stored TOAST value.
      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message)
      SELECT p_history_id,d.request_id,d.opening_message FROM experience.extract_chat_history_display(v_history) d
      WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
      ON CONFLICT(history_id) DO UPDATE SET request_id=excluded.request_id,
        opening_message=excluded.opening_message;
    ELSE
      -- No history assignment: initial replay cannot erase the opening or invalidate its projection.
      UPDATE experience.chat_history SET llm_charge_id=COALESCE(v_charge_id,llm_charge_id)
      WHERE id=p_history_id;
      -- db reorg 6b-1c: the frozen quote lives in billing.usage_charges.quote.snapshot.
      IF p_input ? 'snapshot' THEN PERFORM billing.save_chat_turn_quote(p_history_id,p_input->'snapshot'); END IF;
    END IF;
  END IF;
  -- chat-wallet-reservation-v1
  IF p_input ? 'snapshot' THEN PERFORM billing.reserve_chat_charge(p_history_id); END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN RETURN; END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms,recoverable_delivery,measurement_method)
  VALUES(p_history_id,v_request_id,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer,COALESCE((p_input->>'recoverable_delivery')::boolean,false),p_input->>'measurement_method');
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$function$;

-- production body (2026-11-26, md5 dfc2660768e9dae75e5e2ec7a70f7b4e)
CREATE OR REPLACE FUNCTION experience.observe_chat_generation_attempt(p_history_id uuid, p_observation jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE a experience.chat_generation_attempts%ROWTYPE; v_discarded jsonb; v_input jsonb;
BEGIN
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=(p_observation->>'id')::uuid AND chat_history_id=p_history_id FOR UPDATE;
  IF a.provider IS DISTINCT FROM p_observation->>'provider' OR a.provider_model_id IS DISTINCT FROM p_observation->>'model' OR a.role IS DISTINCT FROM p_observation->>'role' THEN
    RAISE EXCEPTION 'Attempt route cannot be rebound' USING ERRCODE='22023';
  END IF;
  IF a.generation_id IS NOT NULL AND p_observation->>'generation_id' IS NOT NULL AND a.generation_id <> p_observation->>'generation_id' THEN
    RAISE EXCEPTION 'Attempt generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- A stopped loser is terminal (db reorg 6a-2c-3: its fragment lives in ops.llm_calls.discarded_detail).
  -- Replayed/later snapshots cannot overwrite or enlarge it, and duplicate reports cause no UPDATE.
  IF EXISTS (SELECT 1 FROM ops.llm_calls l WHERE l.id=a.id AND l.discarded_detail IS NOT NULL) THEN RETURN; END IF;
  IF p_observation ? 'discarded_response' THEN
    v_input:=p_observation->'discarded_response';
    IF jsonb_typeof(v_input) IS DISTINCT FROM 'object'
       OR v_input->>'reason' IS DISTINCT FROM 'race_lost'
       OR jsonb_typeof(v_input->'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_input->'reasoning') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_input->'truncated') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid discarded attempt snapshot' USING ERRCODE='22023';
    END IF;
    -- Rebuild an explicit allowlist; never persist arbitrary provider objects.
    v_discarded:=jsonb_build_object('reason','race_lost',
      'content',left(v_input->>'content',2048),'reasoning',left(v_input->>'reasoning',2048),
      'truncated',(v_input->>'truncated')::boolean OR length(v_input->>'content')>2048 OR length(v_input->>'reasoning')>2048);
  END IF;
  UPDATE experience.chat_generation_attempts SET
    generation_id=COALESCE(generation_id,p_observation->>'generation_id'),
    dispatched_at=COALESCE(dispatched_at,(p_observation->>'dispatched_at')::timestamptz),
    dispatch_offset_ms=COALESCE(dispatch_offset_ms,(p_observation->>'dispatch_offset_ms')::numeric),
    first_token_ms=COALESCE(first_token_ms,(p_observation->>'first_token_ms')::numeric),
    observed_until_ms=GREATEST(observed_until_ms,(p_observation->>'observed_until_ms')::numeric),
    end_reason=CASE WHEN v_discarded IS NOT NULL THEN 'cancelled' ELSE COALESCE(end_reason,p_observation->>'end_reason') END,
    finish_reason=COALESCE(finish_reason,left(p_observation->>'finish_reason',128)),updated_at=clock_timestamp()
  WHERE id=a.id;
  IF v_discarded IS NOT NULL THEN
    INSERT INTO ops.llm_calls AS l (id,attempt_id,chat_history_id,provider,model,generation_id,discarded_detail)
    VALUES (a.id,a.id,a.chat_history_id,a.provider,a.provider_model_id,
            COALESCE(a.generation_id,p_observation->>'generation_id'),v_discarded)
    ON CONFLICT (id) DO UPDATE SET discarded_detail=COALESCE(l.discarded_detail,EXCLUDED.discarded_detail),updated_at=now();
  END IF;
END;
$function$;

-- production body (2026-11-26, md5 97b95292e697132ca73b535cc568e451)
CREATE OR REPLACE FUNCTION experience.record_chat_delivery_preview(p_history_id uuid, p_revision integer, p_ready_ms numeric, p_kind text, p_text text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE h experience.chat_history%ROWTYPE;
BEGIN
 IF p_kind NOT IN ('delta','reasoning') OR p_ready_ms IS NULL OR p_ready_ms<0 OR length(btrim(p_text))=0 OR length(p_text)>2048 THEN
  RAISE EXCEPTION 'Invalid delivery checkpoint' USING ERRCODE='22023';
 END IF;
 SELECT * INTO h FROM experience.chat_history WHERE id=p_history_id AND revision=p_revision FOR UPDATE;
 IF NOT FOUND OR h.status<>'streaming' OR h.llm_finish_reason IS NOT NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=h.id AND recoverable_delivery AND p_ready_ms<first_token_deadline_ms) THEN RETURN false; END IF;
 -- p5: the first-token preview is delivery state (chat_generation_requests only).
 UPDATE experience.chat_generation_requests SET server_first_token_ready_ms=COALESCE(server_first_token_ready_ms,p_ready_ms),
   first_token_preview=COALESCE(first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text))
 WHERE chat_history_id=h.id;
 RETURN true;
END;
$function$;

-- production body (2026-11-26, md5 350609cb9e92730473ca84ec4ad5bc3b)
CREATE OR REPLACE FUNCTION experience.report_chat_first_token(p_user_id uuid, p_session_id uuid, p_report jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text; v_reason text;
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
  -- server-facts-delivery-v1: a browser deadline stays a measurement. Only a relayed
  -- server failure marks delivery failed, which is what releases quota and waives billing.
  v_delivery_failed := COALESCE((r.recoverable_delivery AND (p_report->>'backgrounded')::boolean=false
    AND v_reason IN ('server_timeout','primary_timeout','fallback_timeout')),false);
  UPDATE experience.chat_generation_requests SET client_outcome=v_outcome,
    client_delivery_failed=client_delivery_failed OR v_delivery_failed,
    client_first_token_visible_ms=CASE WHEN v_outcome='observed' THEN (p_report->>'first_token_visible_ms')::numeric END,
    measurement_method=p_report->>'measurement_method',client_reason=v_reason
  WHERE chat_history_id=r.chat_history_id;
  RETURN true;
END;
$function$;

-- production body (2026-11-26, md5 48d77c3a3566f8f42dc26c3aa3f0ac1a)
CREATE OR REPLACE FUNCTION experience.prepare_chat_generation_fallback(p_history_id uuid, p_attempt_id uuid, p_triggered_ms numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r experience.chat_generation_requests%ROWTYPE; existing_id uuid;
BEGIN
  -- Keep the established lock order. This RPC records a scheduled attempt,
  -- never permission to call a model. Slow storage may trail the winner
  -- or cancellation, so preserve facts without reopening delivery or billing.
  PERFORM 1 FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  IF p_attempt_id IS NULL OR p_triggered_ms IS NULL OR p_triggered_ms<0
     OR p_triggered_ms>=r.first_token_deadline_ms THEN
    RAISE EXCEPTION 'Fallback dispatch was outside the frozen first-token budget' USING ERRCODE='22023';
  END IF;
  SELECT id INTO existing_id FROM experience.chat_generation_attempts WHERE chat_history_id=p_history_id AND role='fallback';
  IF existing_id IS NOT NULL THEN
    IF existing_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Fallback attempt identity conflict' USING ERRCODE='PT409';
  END IF;
  UPDATE experience.chat_generation_requests SET fallback_triggered_ms=COALESCE(fallback_triggered_ms,p_triggered_ms) WHERE chat_history_id=p_history_id;
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES(p_attempt_id,p_history_id,'fallback','openrouter',r.fallback_model_id);
END;
$function$;

-- production body (2026-11-26, md5 392e0acfd462e8ba599ee2b6d2efa8f4)
CREATE OR REPLACE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid, p_attempt_id uuid, p_generation_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE h experience.chat_history%ROWTYPE; r experience.chat_generation_requests%ROWTYPE; a experience.chat_generation_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=p_attempt_id AND chat_history_id=p_history_id FOR UPDATE;
  -- Either attempt may win; the immutable delivery_attempt_id below arbitrates once.
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  IF r.delivery_attempt_id IS NOT NULL THEN
    IF r.delivery_attempt_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Delivery already belongs to another attempt' USING ERRCODE='PT409';
  END IF;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL OR h.llm_charge_id IS NULL
     -- db reorg 6b-1c: the accepted quote lives in billing.usage_charges.
     OR (SELECT u.quote->'snapshot'->>'charge_id' FROM billing.usage_charges u WHERE u.id=h.llm_charge_id)
        IS DISTINCT FROM h.llm_charge_id::text THEN
    RAISE EXCEPTION 'Cancelled/ended generation cannot choose delivery' USING ERRCODE='PT409';
  END IF;
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- db reorg 6a-2c-1: the delivered attempt is the only call identity; OpenRouter / Venice
  -- metadata lives in ops.llm_calls, written by experience.record_llm_call_metadata.
  IF a.provider='surplus' THEN
    -- Losing Surplus attempts may coexist with an OpenRouter winner; only this RPC
    -- chooses billing/delivery ownership. The call table never changes the parent.
    PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));
  ELSIF a.provider NOT IN ('openrouter','venice','packy','onexmodel') THEN
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
  END IF;
  -- The entire quote stays intact; only these two routing fields are bound to delivery.
  UPDATE billing.usage_charges SET quote=jsonb_set(quote,'{snapshot}',(quote->'snapshot') || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id)),updated_at=now() WHERE id=h.llm_charge_id;
  UPDATE experience.chat_generation_attempts SET generation_id=COALESCE(generation_id,p_generation_id) WHERE id=p_attempt_id;
  UPDATE experience.chat_generation_requests SET delivery_attempt_id=p_attempt_id WHERE chat_history_id=p_history_id;
END;
$function$;
REVOKE ALL ON FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experience.prepare_chat_generation_fallback(uuid,uuid,numeric) TO service_role;
