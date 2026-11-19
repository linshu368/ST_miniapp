-- 数据库重组 6a-2c-2（收缩）：Surplus 调用明细只在 ops（后端发布 #979、旧表 PostgREST 读停涨之后执行）。
--
-- 第一段（一个事务）：
--   - prepare / record / claim 三个函数改为直接读写 ops.llm_calls（调用事实）与 ops.llm_cost_jobs（请求记录补查）。
--     规则逐条照旧：身份冲突 PT409、权威快照覆盖 / 否则只补空值、终态不回退、格式校验 22023、响应元数据大小与安全
--     23514；旧表的列约束（文本长度、调用 ID 格式、耗时有限非负、状态枚举）改在写入前统一校验，违反时同样报 23514。
--     守卫：函数正文必须是生产 11-19 的原文（md5）或已是新版本。
--   - free_zone_turn_facts 改读 ops.llm_calls（列名与类型不变）。
--   提交后等 5 秒，让还在用旧函数体的调用跑完。
-- 第二段（一个事务）：自检旧表每一行在 ops 里相同或更新（第一段之后新函数只写 ops）→ 删镜像触发器、触发器函数与旧表
--   （外键会短暂锁 chat_history 与 attempts，所以放最后）→ 没有函数再引用旧表。
-- 可重跑：函数已是新版本、旧表已删时相应步骤跳过。

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '120s', true);

DO $phase1$
DECLARE
  v_fn record;
  v_state text;
BEGIN
  FOR v_fn IN SELECT * FROM (VALUES
    ('experience.prepare_surplusintelligence_call(uuid,uuid,jsonb)'::regprocedure, '35245d691e80b9df2b18c53744492084'),
    ('experience.record_surplusintelligence_call(uuid,jsonb)'::regprocedure, 'e92f706b2ff33712fdc5d2bca17877e7'),
    ('experience.claim_surplusintelligence_request_record(uuid,timestamptz)'::regprocedure, '55a342d8fd095c22e9a2f75836277df4')
  ) t(fn, original_md5) LOOP
    SELECT CASE
      WHEN md5(prosrc) = v_fn.original_md5 THEN 'original'
      WHEN prosrc ~ 'ops\.llm_calls' AND prosrc !~ 'surplusintelligence_chat_history' THEN 'patched'
      ELSE 'drifted' END INTO v_state
    FROM pg_proc WHERE oid = v_fn.fn;
    IF v_state = 'drifted' THEN
      RAISE EXCEPTION 'p6a2c2c: % drifted from the production body', v_fn.fn;
    END IF;
    RAISE NOTICE 'p6a2c2c: % is %', v_fn.fn, v_state;
  END LOOP;
END
$phase1$;

CREATE OR REPLACE FUNCTION experience.prepare_surplusintelligence_call(p_history_id uuid, p_attempt_id uuid,
  p_request_parameters jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE h experience.chat_history%ROWTYPE; l ops.llm_calls%ROWTYPE; v_id uuid;
BEGIN
  -- db reorg 6a-2c-2: the call row lives in ops.llm_calls, its request-record retry state in ops.llm_cost_jobs.
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' FOR UPDATE;
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
  IF l.raw_request IS NOT NULL THEN
    IF l.raw_request IS DISTINCT FROM p_request_parameters OR l.attempt_id IS DISTINCT FROM p_attempt_id THEN
      RAISE EXCEPTION 'Surplus request identity or parameters differ' USING ERRCODE='PT409';
    END IF;
    RETURN;
  END IF;
  IF h.status<>'streaming' OR h.llm_finish_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Inactive generation cannot prepare Surplus dispatch' USING ERRCODE='PT409';
  END IF;
  IF l.id IS NOT NULL THEN
    -- A call row without frozen parameters (pre-prepare history): freeze them in place.
    UPDATE ops.llm_calls SET raw_request=p_request_parameters,
      attempt_id=CASE WHEN p_attempt_id=id THEN p_attempt_id ELSE attempt_id END, updated_at=clock_timestamp()
    WHERE id=l.id;
    v_id:=l.id;
  ELSE
    v_id:=COALESCE(p_attempt_id,gen_random_uuid());
    INSERT INTO ops.llm_calls(id,attempt_id,chat_history_id,provider,raw_request,call_status,raw_usage,capture_status)
    VALUES(v_id,p_attempt_id,p_history_id,'surplus',p_request_parameters,'prepared','{}'::jsonb,'unavailable');
  END IF;
  INSERT INTO ops.llm_cost_jobs(call_id,kind,status,attempts) VALUES(v_id,'surplus_request_record','pending',0)
  ON CONFLICT(call_id) DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p_patch jsonb) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE l ops.llm_calls%ROWTYPE; j ops.llm_cost_jobs%ROWTYPE; merged jsonb; token_field text;
  evidence jsonb; authoritative boolean:=false; effective_request_id text;
  v_generation_id text; v_request_id text; v_model text; v_provider_name text; v_http_status integer; v_call_status text;
  v_finish_reason text; v_error_code text; v_prompt bigint; v_completion bigint; v_total bigint; v_cached bigint;
  v_reasoning bigint; v_cost numeric; v_reported numeric; v_latency numeric; v_generation_time numeric; v_capture text;
BEGIN
  -- db reorg 6a-2c-2: the call row lives in ops.llm_calls, its request-record retry state in ops.llm_cost_jobs.
  SELECT * INTO STRICT l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' FOR UPDATE;
  SELECT * INTO STRICT j FROM ops.llm_cost_jobs WHERE call_id=l.id AND kind='surplus_request_record' FOR UPDATE;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch-ARRAY['generation_id','request_id','model','provider_name','http_status','call_status',
    'finish_reason','error_code','prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens','buyer_cost_micro',
    'usage_usd','latency_ms','generation_time_ms','response_metadata','metadata_capture_status','request_record_status',
    'request_record_attempts','request_record_next_retry_at']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid Surplus observation patch' USING ERRCODE='22023';
  END IF;
  IF (l.generation_id IS NOT NULL AND p_patch->>'generation_id' IS NOT NULL AND l.generation_id<>p_patch->>'generation_id')
     OR (l.request_id IS NOT NULL AND p_patch->>'request_id' IS NOT NULL AND l.request_id<>p_patch->>'request_id') THEN
    RAISE EXCEPTION 'Surplus call identity conflict' USING ERRCODE='PT409';
  END IF;
  IF p_patch->>'request_record_status'='complete' THEN
    evidence:=p_patch#>'{response_metadata,request_record}';
    IF jsonb_typeof(evidence->'data')='object' THEN evidence:=evidence->'data';
    ELSIF jsonb_typeof(evidence->'request')='object' THEN evidence:=evidence->'request'; END IF;
    effective_request_id:=COALESCE(l.request_id,p_patch->>'request_id');
    IF effective_request_id IS NULL OR COALESCE(evidence->>'request_id',evidence->>'id') IS DISTINCT FROM effective_request_id
       OR (l.generation_id IS NOT NULL AND evidence->>'generation_id' IS NOT NULL AND l.generation_id<>evidence->>'generation_id') THEN
      RAISE EXCEPTION 'Surplus settled request evidence identity differs' USING ERRCODE='PT409';
    END IF;
    authoritative:=true;
  END IF;
  -- A first-ID frame may contain provisional zero usage. Its terminal snapshot
  -- can update projections once; late frames cannot reopen that decision.
  authoritative:=authoritative OR (l.call_status IN ('prepared','dispatched','unknown')
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
  merged:=experience.merge_surplus_call_metadata(COALESCE(l.raw_usage,'{}'::jsonb),p_patch->'response_metadata');
  IF jsonb_typeof(merged) IS DISTINCT FROM 'object' OR octet_length(merged::text)>131072
     OR merged-ARRAY['body','stream','headers','request_record','capture']<>'{}'::jsonb
     OR NOT experience.surplus_call_json_safe(merged) THEN
    RAISE EXCEPTION 'Unsafe or oversized controlled Surplus response' USING ERRCODE='23514';
  END IF;
  v_generation_id:=COALESCE(l.generation_id,p_patch->>'generation_id');
  v_request_id:=COALESCE(l.request_id,p_patch->>'request_id');
  v_model:=CASE WHEN authoritative THEN COALESCE(p_patch->>'model',l.model) ELSE COALESCE(l.model,p_patch->>'model') END;
  v_provider_name:=CASE WHEN authoritative THEN COALESCE(p_patch->>'provider_name',l.provider_name) ELSE COALESCE(l.provider_name,p_patch->>'provider_name') END;
  v_http_status:=COALESCE(l.http_status,(p_patch->>'http_status')::integer);
  v_call_status:=CASE WHEN l.call_status IN ('completed','failed','interrupted') THEN l.call_status ELSE COALESCE(p_patch->>'call_status',l.call_status) END;
  v_finish_reason:=CASE WHEN authoritative THEN COALESCE(p_patch->>'finish_reason',l.finish_reason) ELSE COALESCE(l.finish_reason,p_patch->>'finish_reason') END;
  v_error_code:=COALESCE(l.error_code,p_patch->>'error_code');
  v_prompt:=CASE WHEN authoritative THEN COALESCE((p_patch->>'prompt_tokens')::bigint,l.prompt_tokens) ELSE COALESCE(l.prompt_tokens,(p_patch->>'prompt_tokens')::bigint) END;
  v_completion:=CASE WHEN authoritative THEN COALESCE((p_patch->>'completion_tokens')::bigint,l.completion_tokens) ELSE COALESCE(l.completion_tokens,(p_patch->>'completion_tokens')::bigint) END;
  v_total:=CASE WHEN authoritative THEN COALESCE((p_patch->>'total_tokens')::bigint,l.total_tokens) ELSE COALESCE(l.total_tokens,(p_patch->>'total_tokens')::bigint) END;
  v_cached:=CASE WHEN authoritative THEN COALESCE((p_patch->>'cached_tokens')::bigint,l.cached_tokens) ELSE COALESCE(l.cached_tokens,(p_patch->>'cached_tokens')::bigint) END;
  v_reasoning:=CASE WHEN authoritative THEN COALESCE((p_patch->>'reasoning_tokens')::bigint,l.reasoning_tokens) ELSE COALESCE(l.reasoning_tokens,(p_patch->>'reasoning_tokens')::bigint) END;
  -- Surplus reports integer micro-USD; ops.llm_calls stores USD.
  v_cost:=CASE WHEN authoritative THEN COALESCE((p_patch->>'buyer_cost_micro')::numeric/1000000,l.cost_usd) ELSE COALESCE(l.cost_usd,(p_patch->>'buyer_cost_micro')::numeric/1000000) END;
  v_reported:=CASE WHEN authoritative THEN COALESCE((p_patch->>'usage_usd')::numeric,l.reported_cost_usd) ELSE COALESCE(l.reported_cost_usd,(p_patch->>'usage_usd')::numeric) END;
  v_latency:=COALESCE(l.latency_ms,(p_patch->>'latency_ms')::numeric);
  v_generation_time:=COALESCE(l.generation_time_ms,(p_patch->>'generation_time_ms')::numeric);
  v_capture:=CASE WHEN l.capture_status='partial' OR p_patch->>'metadata_capture_status'='partial' THEN 'partial'
    WHEN l.capture_status='complete' THEN 'complete' ELSE COALESCE(p_patch->>'metadata_capture_status',l.capture_status) END;
  -- The former table CHECKs, enforced before the write so a bad provider frame never lands in the call row.
  IF (v_model IS NOT NULL AND length(v_model) NOT BETWEEN 1 AND 512)
     OR (v_provider_name IS NOT NULL AND length(v_provider_name) NOT BETWEEN 1 AND 512)
     OR (v_finish_reason IS NOT NULL AND v_finish_reason !~ '^[a-zA-Z0-9_.:-]{1,128}$')
     OR (v_error_code IS NOT NULL AND v_error_code !~ '^[a-zA-Z0-9_.:-]{1,128}$')
     OR (v_generation_id IS NOT NULL AND (length(v_generation_id) NOT BETWEEN 1 AND 512 OR v_generation_id !~ '^[a-zA-Z0-9_.:-]+$'))
     OR (v_request_id IS NOT NULL AND (length(v_request_id) NOT BETWEEN 1 AND 512 OR v_request_id !~ '^[a-zA-Z0-9_.:-]+$'))
     OR v_call_status NOT IN ('prepared','dispatched','completed','failed','interrupted','unknown')
     OR v_capture NOT IN ('complete','partial','unavailable')
     OR (v_http_status IS NOT NULL AND v_http_status NOT BETWEEN 100 AND 599)
     OR (v_latency IS NOT NULL AND (v_latency < 0 OR v_latency = 'Infinity'::numeric))
     OR (v_generation_time IS NOT NULL AND (v_generation_time < 0 OR v_generation_time = 'Infinity'::numeric)) THEN
    RAISE EXCEPTION 'Surplus call facts violate the call contract' USING ERRCODE='23514';
  END IF;
  UPDATE ops.llm_calls SET generation_id=v_generation_id,request_id=v_request_id,model=v_model,provider_name=v_provider_name,
    http_status=v_http_status,call_status=v_call_status,finish_reason=v_finish_reason,error_code=v_error_code,
    prompt_tokens=v_prompt,completion_tokens=v_completion,total_tokens=v_total,cached_tokens=v_cached,reasoning_tokens=v_reasoning,
    cost_usd=v_cost,cost_source=CASE WHEN v_cost IS NOT NULL THEN 'surplus_buyer' END,reported_cost_usd=v_reported,
    latency_ms=v_latency,generation_time_ms=v_generation_time,raw_usage=merged,capture_status=v_capture,updated_at=clock_timestamp()
  WHERE id=l.id;
  UPDATE ops.llm_cost_jobs SET
    status=CASE WHEN status IN ('complete','unavailable','forbidden','not_found') THEN status
      ELSE COALESCE(p_patch->>'request_record_status',status) END,
    attempts=GREATEST(attempts,COALESCE((p_patch->>'request_record_attempts')::integer,0)),
    next_retry_at=COALESCE((p_patch->>'request_record_next_retry_at')::timestamptz,next_retry_at),updated_at=clock_timestamp()
  WHERE call_id=l.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.claim_surplusintelligence_request_record(p_history_id uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE l ops.llm_calls%ROWTYPE; j ops.llm_cost_jobs%ROWTYPE;
BEGIN
  -- db reorg 6a-2c-2: retry state lives in ops.llm_cost_jobs; the call row's updated_at still drives the stale check.
  SELECT * INTO l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO j FROM ops.llm_cost_jobs WHERE call_id=l.id AND kind='surplus_request_record' FOR UPDATE;
  IF NOT FOUND OR p_now IS NULL OR l.request_id IS NULL OR j.status<>'pending'
     OR j.attempts>=6
     OR (l.call_status IN ('prepared','dispatched') AND l.updated_at>p_now-interval '120 seconds')
     OR j.next_retry_at>p_now THEN RETURN false; END IF;
  UPDATE ops.llm_cost_jobs SET attempts=attempts+1,
    next_retry_at=p_now+make_interval(secs=>LEAST(900,60*power(2,attempts))::integer),updated_at=clock_timestamp()
  WHERE call_id=l.id;
  UPDATE ops.llm_calls SET updated_at=clock_timestamp() WHERE id=l.id;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_turn_facts AS
SELECT f.chat_history_id,
  f.request_received_at AS turn_at,
  f.requested_model_id AS model_id,
  s.provider_name AS served_provider,
  (f.primary_actual_first_token_ms IS NOT NULL) AS primary_output,
  (f.delivery_role = 'fallback'::text) AS fallback_delivered,
  COALESCE(f.server_first_token_timeout, false) AS timed_out,
  f.primary_actual_first_token_ms AS primary_ttft_ms,
  (f.business_finish_reason = 'content_filter'::text) AS refused,
  (f.business_finish_reason = 'length'::text) AS truncated,
  s.cost_usd AS buyer_cost_usd,
  s.prompt_tokens,
  s.cached_tokens,
  COALESCE(f.delivery_role = 'primary'::text, false) AS primary_delivered,
  COALESCE(f.delivery_role = 'primary'::text AND f.business_status = 'stream_interrupted'::text
    AND COALESCE(f.business_finish_reason, ''::text) <> ALL (ARRAY['user_cancelled'::text, 'content_filter'::text]),
    false) AS interrupted
FROM miniapp_analytics.chat_first_token_facts f
LEFT JOIN ops.llm_calls s ON s.chat_history_id = f.chat_history_id AND s.provider = 'surplus'
WHERE f.requested_model_id ~~ 'free-%'::text;
COMMIT;

-- Let calls that started on the old function bodies finish before the table goes away.
SELECT pg_sleep(5);

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '120s', true);

DO $phase2$
DECLARE v_missing bigint; v_differs bigint; v_rows bigint; v_bad text;
BEGIN
  IF to_regclass('experience.surplusintelligence_chat_history') IS NULL THEN
    RAISE NOTICE 'p6a2c2c: Surplus detail table already dropped';
    RETURN;
  END IF;
  -- Every old row must be in ops, identical unless the new functions have written it since (ops is then newer).
  SELECT count(*),
    count(*) FILTER (WHERE l.id IS NULL),
    count(*) FILTER (WHERE l.id IS NOT NULL AND l.updated_at <= s.updated_at AND (
      l.generation_id IS DISTINCT FROM s.generation_id OR l.request_id IS DISTINCT FROM s.request_id
      OR l.call_status IS DISTINCT FROM s.call_status OR l.cost_usd IS DISTINCT FROM s.buyer_cost_micro / 1000000
      OR l.reported_cost_usd IS DISTINCT FROM s.usage_usd OR l.prompt_tokens IS DISTINCT FROM s.prompt_tokens
      OR l.cached_tokens IS DISTINCT FROM s.cached_tokens OR l.provider_name IS DISTINCT FROM s.provider_name
      OR l.raw_request IS DISTINCT FROM s.request_parameters OR l.raw_usage IS DISTINCT FROM s.response_metadata
      OR j.status IS DISTINCT FROM s.request_record_status OR j.attempts IS DISTINCT FROM s.request_record_attempts))
    INTO v_rows, v_missing, v_differs
  FROM experience.surplusintelligence_chat_history s
  LEFT JOIN ops.llm_calls l ON l.id = COALESCE(s.attempt_id, s.id)
  LEFT JOIN ops.llm_cost_jobs j ON j.call_id = l.id;
  IF v_missing > 0 OR v_differs > 0 THEN
    RAISE EXCEPTION 'p6a2c2c: % of % Surplus rows missing from ops, % differ', v_missing, v_rows, v_differs;
  END IF;

  DROP TRIGGER IF EXISTS mirror_surplus_call ON experience.surplusintelligence_chat_history;
  DROP FUNCTION IF EXISTS ops.mirror_surplus_call();
  DROP TABLE experience.surplusintelligence_chat_history;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ 'surplusintelligence_chat_history';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6a2c2c: functions still reference the dropped Surplus table: %', v_bad;
  END IF;
  RAISE NOTICE 'p6a2c2c: % Surplus rows verified in ops, mirror trigger and detail table dropped', v_rows;
END
$phase2$;

NOTIFY pgrst, 'reload schema';
COMMIT;
