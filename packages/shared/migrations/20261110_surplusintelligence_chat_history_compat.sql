-- domain: experience
-- Forward compatibility replacement for the original Surplus migration.
-- Run this file directly if the original failed; do not edit an applied filename.
-- Normalize both installed SQL and every multiline anchor/replacement so Windows
-- CRLF submission preserves the same strict provider-branch contract as LF.
-- Surplus call facts belong to the interaction domain; chat_history retains content,
-- delivery and billing truth. admin's existing catalog validator is widened in-place.
-- TEST first, one file per workflow invocation. No historical content/metadata backfill.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Do not overwrite a newer deployment's functions with an older copied definition.
DO $preflight$
DECLARE d text; c record; expected text;
BEGIN
  IF to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.chat_generation_attempts') IS NULL
     OR to_regclass('experience.chat_generation_requests') IS NULL THEN
    RAISE EXCEPTION 'Surplus migration requires the existing generation schema';
  END IF;
  d := pg_get_functiondef('experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure);
  IF position('IF r.delivery_attempt_id IS NOT NULL' IN d)=0
     OR position('PT409' IN d)=0 OR position('40001' IN d)>0
     OR position('Primary cannot reclaim delivery after fallback' IN d)>0 THEN
    RAISE EXCEPTION 'Apply the existing nonretryable conflict and first-token race migrations first';
  END IF;
  FOR c IN SELECT * FROM (VALUES
    ('chat_generation_requests','requested_provider','chat_generation_requests_requested_provider_check'),
    ('chat_generation_attempts','provider','chat_generation_attempts_provider_check')
  ) AS x(table_name,column_name,constraint_name) LOOP
    SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
    WHERE conrelid=format('experience.%I',c.table_name)::regclass AND conname=c.constraint_name AND contype='c';
    expected := format('CHECK ((%s = ANY (ARRAY[''openrouter''::text, ''venice''::text])))',c.column_name);
    IF d IS DISTINCT FROM expected AND d IS DISTINCT FROM replace(expected,'''venice''::text]','''venice''::text, ''surplus''::text]') THEN
      RAISE EXCEPTION 'Unexpected generation provider constraint: %',c.constraint_name;
    END IF;
    IF position('surplus' IN d)=0 THEN
      EXECUTE format('ALTER TABLE experience.%I DROP CONSTRAINT %I',c.table_name,c.constraint_name);
      EXECUTE format('ALTER TABLE experience.%I ADD CONSTRAINT %I CHECK (%I IN (''openrouter'',''venice'',''surplus'')) NOT VALID',c.table_name,c.constraint_name,c.column_name);
      EXECUTE format('ALTER TABLE experience.%I VALIDATE CONSTRAINT %I',c.table_name,c.constraint_name);
    END IF;
  END LOOP;
  d := pg_get_functiondef('admin.validate_model_catalog_core(jsonb)'::regprocedure);
  IF position('NOT IN (''openrouter'', ''venice'')' IN d)>0 THEN
    IF (length(d)-length(replace(d,'NOT IN (''openrouter'', ''venice'')','')))/length('NOT IN (''openrouter'', ''venice'')')<>1 THEN
      RAISE EXCEPTION 'Ambiguous model catalog provider validation';
    END IF;
    EXECUTE replace(d,'NOT IN (''openrouter'', ''venice'')','NOT IN (''openrouter'', ''venice'', ''surplus'')');
  ELSIF position('NOT IN (''openrouter'', ''venice'', ''surplus'')' IN d)=0 THEN
    RAISE EXCEPTION 'Unexpected model catalog provider validation';
  END IF;
END;
$preflight$;

-- Content guards complement the mapper's strict leaf allowlists. They also protect
-- direct privileged writes from accidentally archiving a whole upstream response.
CREATE OR REPLACE FUNCTION experience.surplus_call_json_safe(p_value jsonb,p_request boolean DEFAULT false,p_depth integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item record; child jsonb;
BEGIN
  IF p_depth>8 THEN RETURN false; END IF;
  IF jsonb_typeof(p_value)='object' THEN
    FOR item IN SELECT * FROM jsonb_each(p_value) LOOP
      IF lower(item.key) IN ('content','reasoning_content','arguments','prompt','messages','input','output',
        'token','bytes','authorization','api_key','apikey','access_token','refresh_token','password','secret',
        'initdata','cookie','set-cookie','account_id','user_id','email','phone','address','url')
         OR (NOT p_request AND lower(item.key)='reasoning') THEN RETURN false; END IF;
      IF NOT experience.surplus_call_json_safe(item.value,p_request,p_depth+1) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value)='array' THEN
    IF jsonb_array_length(p_value)>128 THEN RETURN false; END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF NOT experience.surplus_call_json_safe(child,p_request,p_depth+1) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

CREATE TABLE IF NOT EXISTS experience.surplusintelligence_chat_history (
  id uuid CONSTRAINT surplusintelligence_chat_history_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_history_id uuid NOT NULL,
  attempt_id uuid,
  provider text NOT NULL DEFAULT 'surplus' CONSTRAINT si_history_provider_check CHECK (provider='surplus'),
  request_parameters jsonb,
  generation_id text,
  request_id text,
  model text,
  provider_name text,
  http_status integer CONSTRAINT si_history_http_status_check CHECK (http_status BETWEEN 100 AND 599),
  call_status text NOT NULL DEFAULT 'prepared' CONSTRAINT si_history_call_status_check CHECK (call_status IN ('prepared','dispatched','completed','failed','interrupted','unknown')),
  finish_reason text,
  error_code text,
  prompt_tokens bigint CONSTRAINT si_history_prompt_tokens_check CHECK (prompt_tokens>=0),
  completion_tokens bigint CONSTRAINT si_history_completion_tokens_check CHECK (completion_tokens>=0),
  total_tokens bigint CONSTRAINT si_history_total_tokens_check CHECK (total_tokens>=0),
  cached_tokens bigint CONSTRAINT si_history_cached_tokens_check CHECK (cached_tokens>=0),
  reasoning_tokens bigint CONSTRAINT si_history_reasoning_tokens_check CHECK (reasoning_tokens>=0),
  buyer_cost_micro numeric(30,0) CONSTRAINT si_history_buyer_cost_check CHECK (buyer_cost_micro>=0 AND buyer_cost_micro<>'NaN'::numeric),
  usage_usd numeric(36,12) CONSTRAINT si_history_usage_usd_check CHECK (usage_usd>=0 AND usage_usd<>'NaN'::numeric),
  latency_ms numeric CONSTRAINT si_history_latency_check CHECK (latency_ms>=0 AND latency_ms<'Infinity'::numeric),
  generation_time_ms numeric CONSTRAINT si_history_generation_time_check CHECK (generation_time_ms>=0 AND generation_time_ms<'Infinity'::numeric),
  response_metadata jsonb NOT NULL DEFAULT '{}',
  metadata_capture_status text NOT NULL DEFAULT 'unavailable' CONSTRAINT si_history_capture_status_check CHECK (metadata_capture_status IN ('complete','partial','unavailable')),
  request_record_status text NOT NULL DEFAULT 'pending' CONSTRAINT si_history_record_status_check CHECK (request_record_status IN ('pending','complete','unavailable','forbidden','not_found')),
  request_record_attempts integer NOT NULL DEFAULT 0 CONSTRAINT si_history_record_attempts_check CHECK (request_record_attempts BETWEEN 0 AND 6),
  request_record_next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surplusintelligence_chat_history_parent_key UNIQUE (chat_history_id),
  CONSTRAINT surplusintelligence_chat_history_parent_fk FOREIGN KEY (chat_history_id) REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  CONSTRAINT surplusintelligence_chat_history_attempt_fk FOREIGN KEY (chat_history_id,attempt_id) REFERENCES experience.chat_generation_attempts(chat_history_id,id) ON DELETE CASCADE,
  CONSTRAINT surplusintelligence_chat_history_identity_check CHECK (
    (generation_id IS NULL OR (length(generation_id) BETWEEN 1 AND 512 AND generation_id ~ '^[a-zA-Z0-9_.:-]+$')) AND
    (request_id IS NULL OR (length(request_id) BETWEEN 1 AND 512 AND request_id ~ '^[a-zA-Z0-9_.:-]+$'))),
  CONSTRAINT si_history_scalar_text_check CHECK (
    (model IS NULL OR length(model) BETWEEN 1 AND 512) AND (provider_name IS NULL OR length(provider_name) BETWEEN 1 AND 512)
    AND (finish_reason IS NULL OR finish_reason ~ '^[a-zA-Z0-9_.:-]{1,128}$')
    AND (error_code IS NULL OR error_code ~ '^[a-zA-Z0-9_.:-]{1,128}$')),
  CONSTRAINT surplusintelligence_chat_history_request_check CHECK (request_parameters IS NULL OR
    (jsonb_typeof(request_parameters)='object' AND octet_length(request_parameters::text)<=16384
     AND experience.surplus_call_json_safe(request_parameters,true))),
  CONSTRAINT surplusintelligence_chat_history_response_check CHECK (
    jsonb_typeof(response_metadata)='object' AND octet_length(response_metadata::text)<=131072
    AND response_metadata-ARRAY['body','stream','headers','request_record','capture']='{}'::jsonb
    AND experience.surplus_call_json_safe(response_metadata))
);
DO $shape$
DECLARE actual text[]; expected text[]:=ARRAY['id','chat_history_id','attempt_id','provider','request_parameters','generation_id','request_id','model','provider_name',
  'http_status','call_status','finish_reason','error_code','prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens',
  'buyer_cost_micro','usage_usd','latency_ms','generation_time_ms','response_metadata','metadata_capture_status','request_record_status',
  'request_record_attempts','request_record_next_retry_at','created_at','updated_at']; c record; actual_type text;
BEGIN
  SELECT array_agg(attname::text ORDER BY attnum) INTO actual FROM pg_attribute
  WHERE attrelid='experience.surplusintelligence_chat_history'::regclass AND attnum>0 AND NOT attisdropped;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unexpected existing Surplus history table columns'; END IF;
  FOR c IN SELECT * FROM (VALUES ('request_parameters','jsonb'),('response_metadata','jsonb'),('chat_history_id','uuid'),
    ('attempt_id','uuid'),('request_id','text'),('generation_id','text'),('buyer_cost_micro','numeric(30,0)'),('usage_usd','numeric(36,12)')) AS x(name,type_name) LOOP
    SELECT format_type(atttypid,atttypmod) INTO actual_type FROM pg_attribute
    WHERE attrelid='experience.surplusintelligence_chat_history'::regclass AND attname=c.name AND NOT attisdropped;
    IF actual_type IS DISTINCT FROM c.type_name THEN RAISE EXCEPTION 'Unexpected Surplus history column type: %',c.name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='experience.surplusintelligence_chat_history'::regclass
    AND conname='surplusintelligence_chat_history_parent_fk' AND confrelid='experience.chat_history'::regclass AND confdeltype='c')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='experience.surplusintelligence_chat_history'::regclass
    AND conname='surplusintelligence_chat_history_attempt_fk' AND confrelid='experience.chat_generation_attempts'::regclass AND confdeltype='c') THEN
    RAISE EXCEPTION 'Unexpected Surplus history parent/attempt foreign key';
  END IF;
END;
$shape$;
CREATE INDEX IF NOT EXISTS surplusintelligence_chat_history_generation_idx ON experience.surplusintelligence_chat_history(generation_id) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS surplusintelligence_chat_history_created_idx ON experience.surplusintelligence_chat_history(created_at);
COMMENT ON TABLE experience.surplusintelligence_chat_history IS 'Surplus call parameters and bounded provider facts, including losing attempts; never conversation content or billing authority.';
COMMENT ON COLUMN experience.surplusintelligence_chat_history.request_id IS 'Confirmed supplier request-log ID; not assumed equal to generation_id.';
COMMENT ON COLUMN experience.surplusintelligence_chat_history.response_metadata IS 'Versioned controlled body/stream/headers/request_record/capture evidence, max 128 KiB; no content, credentials or raw errors.';
COMMENT ON COLUMN experience.surplusintelligence_chat_history.buyer_cost_micro IS 'Observed supplier cost in integer micro-USD, never inferred from missing usage; 1 USD = 1000000 micro-USD.';
COMMENT ON COLUMN experience.surplusintelligence_chat_history.latency_ms IS 'Locally observed upstream-to-first-content latency in milliseconds; supplier timing stays separately in metadata.';
ALTER TABLE experience.surplusintelligence_chat_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.surplusintelligence_chat_history FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON experience.surplusintelligence_chat_history TO service_role;

CREATE OR REPLACE FUNCTION experience.merge_surplus_call_metadata(p_existing jsonb,p_incoming jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result jsonb:=COALESCE(p_existing,'{}'::jsonb); item record; counter record; counts jsonb; child jsonb; slot integer;
BEGIN
  IF p_incoming IS NULL OR p_incoming='null'::jsonb THEN RETURN p_existing; END IF;
  IF p_existing='true'::jsonb AND p_incoming='false'::jsonb THEN RETURN p_existing; END IF;
  IF jsonb_typeof(p_existing)='array' AND jsonb_typeof(p_incoming)='array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(p_incoming) LOOP
      -- Choices are identified by their protocol index, not current array position.
      SELECT ordinality::integer-1 INTO slot FROM jsonb_array_elements(result) WITH ORDINALITY AS a(value,ordinality)
      WHERE child ? 'index' AND value->'index'=child->'index' LIMIT 1;
      IF slot IS NOT NULL THEN
        result:=jsonb_set(result,ARRAY[slot::text],experience.merge_surplus_call_metadata(result->slot,child));
      ELSIF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result) AS a(value) WHERE value=child) THEN
        IF jsonb_array_length(result)>=128 THEN RAISE EXCEPTION 'Merged Surplus metadata array exceeds its budget' USING ERRCODE='22023'; END IF;
        result:=result||jsonb_build_array(child);
      END IF;
    END LOOP;
    RETURN result;
  END IF;
  IF jsonb_typeof(p_incoming)<>'object' OR (p_existing IS NOT NULL AND jsonb_typeof(p_existing)<>'object') THEN RETURN p_incoming; END IF;
  FOR item IN SELECT * FROM jsonb_each(p_incoming) LOOP
    IF item.key='status' AND result->>'status'='partial' AND item.value IN ('"complete"'::jsonb,'"unavailable"'::jsonb) THEN CONTINUE; END IF;
    IF item.key='status' AND result->>'status'='complete' AND item.value='"unavailable"'::jsonb THEN CONTINUE; END IF;
    IF item.key='counts' AND jsonb_typeof(item.value)='object' AND jsonb_typeof(result->'counts')='object' THEN
      counts:=result->'counts';
      FOR counter IN SELECT * FROM jsonb_each(item.value) LOOP
        IF jsonb_typeof(counter.value)='number' AND jsonb_typeof(counts->counter.key)='number' THEN
          counts:=jsonb_set(counts,ARRAY[counter.key],to_jsonb(GREATEST((counts->>counter.key)::numeric,(counter.value#>>'{}')::numeric)));
        ELSE counts:=jsonb_set(counts,ARRAY[counter.key],counter.value); END IF;
      END LOOP;
      result:=jsonb_set(result,ARRAY[item.key],counts);
      CONTINUE;
    END IF;
    result:=jsonb_set(result,ARRAY[item.key],COALESCE(experience.merge_surplus_call_metadata(result->item.key,item.value),'null'::jsonb));
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION experience.prepare_surplusintelligence_call(p_history_id uuid,p_attempt_id uuid,p_request_parameters jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE h experience.chat_history%ROWTYPE; s experience.surplusintelligence_chat_history%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO s FROM experience.surplusintelligence_chat_history WHERE chat_history_id=p_history_id FOR UPDATE;
  IF p_request_parameters IS NULL OR jsonb_typeof(p_request_parameters) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_request_parameters->'model') IS DISTINCT FROM 'string'
     OR length(p_request_parameters->>'model') NOT BETWEEN 1 AND 512
     OR jsonb_typeof(p_request_parameters->'stream') IS DISTINCT FROM 'boolean'
     OR p_request_parameters-ARRAY['model','stream','temperature','top_p','top_k','top_a','min_p','frequency_penalty','presence_penalty',
       'repetition_penalty','max_tokens','max_completion_tokens','seed','reasoning','reasoning_effort','stream_options','stop','response_format',
       'provider','providers_blocked','provider_order','si_route']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid controlled Surplus request parameters' USING ERRCODE='22023';
  END IF;
  IF octet_length(p_request_parameters::text)>16384 OR NOT experience.surplus_call_json_safe(p_request_parameters,true) THEN
    -- A CHECK's failing-row DETAIL could echo the rejected payload into {err} logs.
    RAISE EXCEPTION 'Unsafe or oversized controlled Surplus request' USING ERRCODE='23514';
  END IF;
  IF p_attempt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM experience.chat_generation_attempts
    WHERE id=p_attempt_id AND chat_history_id=p_history_id AND provider='surplus' AND provider_model_id=p_request_parameters->>'model') THEN
    RAISE EXCEPTION 'Surplus attempt identity differs' USING ERRCODE='PT409';
  END IF;
  IF s.request_parameters IS NOT NULL THEN
    IF s.request_parameters IS DISTINCT FROM p_request_parameters OR s.attempt_id IS DISTINCT FROM p_attempt_id THEN
      RAISE EXCEPTION 'Surplus request identity or parameters differ' USING ERRCODE='PT409';
    END IF;
    RETURN;
  END IF;
  IF h.status<>'streaming' OR h.llm_finish_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Inactive generation cannot prepare Surplus dispatch' USING ERRCODE='PT409';
  END IF;
  INSERT INTO experience.surplusintelligence_chat_history(chat_history_id,attempt_id,request_parameters)
  VALUES(p_history_id,p_attempt_id,p_request_parameters)
  ON CONFLICT(chat_history_id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id,request_parameters=EXCLUDED.request_parameters,
    updated_at=clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid,p_patch jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s experience.surplusintelligence_chat_history%ROWTYPE; merged jsonb; token_field text;
  evidence jsonb; authoritative boolean:=false; effective_request_id text;
BEGIN
  SELECT * INTO STRICT s FROM experience.surplusintelligence_chat_history WHERE chat_history_id=p_history_id FOR UPDATE;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch-ARRAY['generation_id','request_id','model','provider_name','http_status','call_status',
    'finish_reason','error_code','prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens','buyer_cost_micro',
    'usage_usd','latency_ms','generation_time_ms','response_metadata','metadata_capture_status','request_record_status',
    'request_record_attempts','request_record_next_retry_at']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid Surplus observation patch' USING ERRCODE='22023';
  END IF;
  IF (s.generation_id IS NOT NULL AND p_patch->>'generation_id' IS NOT NULL AND s.generation_id<>p_patch->>'generation_id')
     OR (s.request_id IS NOT NULL AND p_patch->>'request_id' IS NOT NULL AND s.request_id<>p_patch->>'request_id') THEN
    RAISE EXCEPTION 'Surplus call identity conflict' USING ERRCODE='PT409';
  END IF;
  IF p_patch->>'request_record_status'='complete' THEN
    evidence:=p_patch#>'{response_metadata,request_record}';
    IF jsonb_typeof(evidence->'data')='object' THEN evidence:=evidence->'data';
    ELSIF jsonb_typeof(evidence->'request')='object' THEN evidence:=evidence->'request'; END IF;
    effective_request_id:=COALESCE(s.request_id,p_patch->>'request_id');
    IF effective_request_id IS NULL OR COALESCE(evidence->>'request_id',evidence->>'id') IS DISTINCT FROM effective_request_id
       OR (s.generation_id IS NOT NULL AND evidence->>'generation_id' IS NOT NULL AND s.generation_id<>evidence->>'generation_id') THEN
      RAISE EXCEPTION 'Surplus settled request evidence identity differs' USING ERRCODE='PT409';
    END IF;
    authoritative:=true;
  END IF;
  -- A first-ID frame may contain provisional zero usage. Its terminal snapshot
  -- can update projections once; late frames cannot reopen that decision.
  authoritative:=authoritative OR (s.call_status IN ('prepared','dispatched','unknown')
    AND p_patch->>'call_status' IN ('completed','failed','interrupted'));
  -- Reject fractional values before numeric typmods could silently round them.
  IF p_patch->>'buyer_cost_micro' IS NOT NULL AND p_patch->>'buyer_cost_micro' !~ '^[0-9]{1,30}$' THEN
    RAISE EXCEPTION 'Invalid Surplus integer micro-USD cost' USING ERRCODE='22023';
  END IF;
  IF p_patch->>'usage_usd' IS NOT NULL AND p_patch->>'usage_usd' !~ '^[0-9]{1,24}([.][0-9]{1,12})?$' THEN
    RAISE EXCEPTION 'Invalid Surplus USD cost' USING ERRCODE='22023';
  END IF;
  FOREACH token_field IN ARRAY ARRAY['prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens'] LOOP
    IF p_patch->>token_field IS NOT NULL AND (p_patch->>token_field !~ '^[0-9]{1,16}$'
      OR (p_patch->>token_field)::numeric>9007199254740991) THEN
      RAISE EXCEPTION 'Invalid Surplus token count' USING ERRCODE='22023';
    END IF;
  END LOOP;
  merged:=experience.merge_surplus_call_metadata(s.response_metadata,p_patch->'response_metadata');
  IF jsonb_typeof(merged) IS DISTINCT FROM 'object' OR octet_length(merged::text)>131072
     OR merged-ARRAY['body','stream','headers','request_record','capture']<>'{}'::jsonb
     OR NOT experience.surplus_call_json_safe(merged) THEN
    RAISE EXCEPTION 'Unsafe or oversized controlled Surplus response' USING ERRCODE='23514';
  END IF;
  UPDATE experience.surplusintelligence_chat_history SET
    generation_id=COALESCE(generation_id,p_patch->>'generation_id'),request_id=COALESCE(request_id,p_patch->>'request_id'),
    model=CASE WHEN authoritative THEN COALESCE(p_patch->>'model',model) ELSE COALESCE(model,p_patch->>'model') END,
    provider_name=CASE WHEN authoritative THEN COALESCE(p_patch->>'provider_name',provider_name) ELSE COALESCE(provider_name,p_patch->>'provider_name') END,
    http_status=COALESCE(http_status,(p_patch->>'http_status')::integer),
    call_status=CASE WHEN call_status IN ('completed','failed','interrupted') THEN call_status ELSE COALESCE(p_patch->>'call_status',call_status) END,
    finish_reason=CASE WHEN authoritative THEN COALESCE(p_patch->>'finish_reason',finish_reason) ELSE COALESCE(finish_reason,p_patch->>'finish_reason') END,
    error_code=COALESCE(error_code,p_patch->>'error_code'),
    prompt_tokens=CASE WHEN authoritative THEN COALESCE((p_patch->>'prompt_tokens')::bigint,prompt_tokens) ELSE COALESCE(prompt_tokens,(p_patch->>'prompt_tokens')::bigint) END,
    completion_tokens=CASE WHEN authoritative THEN COALESCE((p_patch->>'completion_tokens')::bigint,completion_tokens) ELSE COALESCE(completion_tokens,(p_patch->>'completion_tokens')::bigint) END,
    total_tokens=CASE WHEN authoritative THEN COALESCE((p_patch->>'total_tokens')::bigint,total_tokens) ELSE COALESCE(total_tokens,(p_patch->>'total_tokens')::bigint) END,
    cached_tokens=CASE WHEN authoritative THEN COALESCE((p_patch->>'cached_tokens')::bigint,cached_tokens) ELSE COALESCE(cached_tokens,(p_patch->>'cached_tokens')::bigint) END,
    reasoning_tokens=CASE WHEN authoritative THEN COALESCE((p_patch->>'reasoning_tokens')::bigint,reasoning_tokens) ELSE COALESCE(reasoning_tokens,(p_patch->>'reasoning_tokens')::bigint) END,
    buyer_cost_micro=CASE WHEN authoritative THEN COALESCE((p_patch->>'buyer_cost_micro')::numeric,buyer_cost_micro) ELSE COALESCE(buyer_cost_micro,(p_patch->>'buyer_cost_micro')::numeric) END,
    usage_usd=CASE WHEN authoritative THEN COALESCE((p_patch->>'usage_usd')::numeric,usage_usd) ELSE COALESCE(usage_usd,(p_patch->>'usage_usd')::numeric) END,
    latency_ms=COALESCE(latency_ms,(p_patch->>'latency_ms')::numeric),
    generation_time_ms=COALESCE(generation_time_ms,(p_patch->>'generation_time_ms')::numeric),response_metadata=merged,
    metadata_capture_status=CASE WHEN metadata_capture_status='partial' OR p_patch->>'metadata_capture_status'='partial' THEN 'partial'
      WHEN metadata_capture_status='complete' THEN 'complete' ELSE COALESCE(p_patch->>'metadata_capture_status',metadata_capture_status) END,
    request_record_status=CASE WHEN request_record_status IN ('complete','unavailable','forbidden','not_found') THEN request_record_status
      ELSE COALESCE(p_patch->>'request_record_status',request_record_status) END,
    request_record_attempts=GREATEST(request_record_attempts,COALESCE((p_patch->>'request_record_attempts')::integer,0)),
    request_record_next_retry_at=COALESCE((p_patch->>'request_record_next_retry_at')::timestamptz,request_record_next_retry_at),updated_at=clock_timestamp()
  WHERE chat_history_id=p_history_id;
END;
$$;

CREATE OR REPLACE FUNCTION experience.claim_surplusintelligence_request_record(p_history_id uuid,p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s experience.surplusintelligence_chat_history%ROWTYPE;
BEGIN
  SELECT * INTO s FROM experience.surplusintelligence_chat_history WHERE chat_history_id=p_history_id FOR UPDATE;
  IF NOT FOUND OR p_now IS NULL OR s.request_id IS NULL OR s.request_record_status<>'pending'
     OR s.request_record_attempts>=6
     OR (s.call_status IN ('prepared','dispatched') AND s.updated_at>p_now-interval '120 seconds')
     OR s.request_record_next_retry_at>p_now THEN RETURN false; END IF;
  UPDATE experience.surplusintelligence_chat_history SET request_record_attempts=request_record_attempts+1,
    request_record_next_retry_at=p_now+make_interval(secs=>LEAST(900,60*power(2,request_record_attempts))::integer),updated_at=clock_timestamp()
  WHERE chat_history_id=p_history_id;
  RETURN true;
END;
$$;

-- Change only the provider branch; retain the installed immutable winner/quote CAS.
DO $delivery$
DECLARE d text; old text; replacement text; fn regprocedure:='experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure;
BEGIN
  d:=replace(pg_get_functiondef(fn),E'\r\n',E'\n');
  old:=replace($anchor$  ELSE
    IF EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;$anchor$,E'\r\n',E'\n');
  IF position('ELSIF a.provider=''surplus''' IN d)=0 THEN
    IF (length(d)-length(replace(d,old,'')))/length(old)<>1
       OR (length(d)-length(replace(d,'IF a.provider=''openrouter'' THEN','')))/length('IF a.provider=''openrouter'' THEN')<>1 THEN
      RAISE EXCEPTION 'Unexpected installed delivery provider branch';
    END IF;
    replacement:=replace($branch$  ELSIF a.provider='surplus' THEN
    -- Losing Surplus attempts may coexist with an OpenRouter winner; only this RPC
    -- chooses billing/delivery ownership. The call table never changes the parent.
    PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));
  ELSIF a.provider='venice' THEN
    IF EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;$branch$,E'\r\n',E'\n');
    d:=replace(d,old,replacement);
    old:=replace($anchor$  END IF;
  -- The entire quote stays intact;$anchor$,E'\r\n',E'\n');
    IF (length(d)-length(replace(d,old,'')))/length(old)<>1 THEN
      RAISE EXCEPTION 'Unexpected delivery quote boundary';
    END IF;
    d:=replace(d,old,replace($branch$  ELSE
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
  END IF;
  -- The entire quote stays intact;$branch$,E'\r\n',E'\n'));
    EXECUTE d;
  END IF;
  IF to_regprocedure('experience.select_chat_generation_delivery(uuid,uuid,text)') IS DISTINCT FROM fn
     OR position('PT409' IN pg_get_functiondef(fn))=0 THEN RAISE EXCEPTION 'Delivery function identity changed'; END IF;
END;
$delivery$;

DO $permissions$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'experience.surplus_call_json_safe(jsonb,boolean,integer)',
    'experience.merge_surplus_call_metadata(jsonb,jsonb)',
    'experience.prepare_surplusintelligence_call(uuid,uuid,jsonb)',
    'experience.record_surplusintelligence_call(uuid,jsonb)',
    'experience.claim_surplusintelligence_request_record(uuid,timestamp with time zone)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',signature);
  END LOOP;
END;
$permissions$;
NOTIFY pgrst,'reload schema';
COMMIT;

-- Recovery: disable Surplus catalog entries first and retain this additive table.
-- Never restore the old ELSE-Venice function or drop recorded call facts on rollback.
-- Inspect shape/ACL/ledger after an unknown outcome; use reviewed forward-fix, not blind rerun.
