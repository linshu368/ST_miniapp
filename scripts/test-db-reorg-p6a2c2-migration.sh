#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c2_surplus_expand.sql (after the 6a-2c-1 expand) as a NON-superuser with CREATEROLE:
# - prepare / record / claim are the production bodies (md5); their JSON helpers are stubs (validation is not under test);
# - existing Surplus rows are copied into ops.llm_calls + ops.llm_cost_jobs (buyer micro-USD -> USD);
# - every later write through the three production functions is mirrored exactly (same transaction);
# - read_surplus_call returns the request parameters / call id, and the response metadata only on request;
# - list_surplus_request_record_candidates returns exactly the rows the old PostgREST scan selected;
# - only service_role may call the RPCs; a rerun copies nothing twice.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
mig="$task_root/packages/shared/migrations"
expand_2c1="$mig/20261119_db_reorg_p6a2c1_llm_calls_expand.sql"
migration="$mig/20261119_db_reorg_p6a2c2_surplus_expand.sql"
task_container="st-db-reorg-p6a2c2-${RANDOM}-$$"
task_tmp="$(mktemp -d)"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$task_tmp"' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$("${admin_psql[@]}" -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT anon, authenticated, service_role TO app_admin;
CREATE SCHEMA experience; CREATE SCHEMA ops; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA experience, ops, test_fixture TO service_role;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, model text NOT NULL, session_id uuid, status text NOT NULL,
  llm_finish_reason text, llm_charge_id uuid, assistant_reply text, llm_billing_snapshot jsonb,
  llm_billing_settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id), delivery_attempt_id uuid);
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL REFERENCES experience.chat_generation_requests(chat_history_id),
  role text NOT NULL, provider text NOT NULL, provider_model_id text NOT NULL, generation_id text,
  UNIQUE (chat_history_id, role), UNIQUE (chat_history_id, id));
-- The two OpenRouter / Venice detail tables only exist so the 6a-2c-1 expand can run as the starting shape.
CREATE TABLE experience.openrouter_chat_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_history_id uuid NOT NULL,
  llm_generation_id text, llm_generation_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), provider_name text, finish_reason text, usage jsonb, usage_cache jsonb,
  native_tokens_cached integer, native_tokens_reasoning integer, native_tokens_completion integer,
  native_tokens_prompt integer, latency numeric, generation_time numeric, model text);
CREATE TABLE experience.venice_chat_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_history_id uuid NOT NULL,
  llm_provider_name text NOT NULL DEFAULT 'venice', llm_finish_reason text, llm_usage jsonb, llm_usage_cache jsonb,
  llm_native_tokens_cached integer, llm_native_tokens_reasoning integer, llm_native_tokens_completion integer,
  llm_native_tokens_prompt integer, llm_latency numeric, llm_generation_time numeric, llm_model text,
  llm_generation_id text, llm_generation_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.surplusintelligence_chat_history (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_history_id uuid NOT NULL UNIQUE REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  attempt_id uuid, provider text NOT NULL DEFAULT 'surplus' CHECK (provider = 'surplus'), request_parameters jsonb,
  generation_id text, request_id text, model text, provider_name text,
  http_status integer CHECK (http_status >= 100 AND http_status <= 599),
  call_status text NOT NULL DEFAULT 'prepared' CHECK (call_status IN ('prepared','dispatched','completed','failed','interrupted','unknown')),
  finish_reason text, error_code text, prompt_tokens bigint, completion_tokens bigint, total_tokens bigint,
  cached_tokens bigint, reasoning_tokens bigint, buyer_cost_micro numeric, usage_usd numeric, latency_ms numeric,
  generation_time_ms numeric, response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_capture_status text NOT NULL DEFAULT 'unavailable' CHECK (metadata_capture_status IN ('complete','partial','unavailable')),
  request_record_status text NOT NULL DEFAULT 'pending' CHECK (request_record_status IN ('pending','complete','unavailable','forbidden','not_found')),
  request_record_attempts integer NOT NULL DEFAULT 0 CHECK (request_record_attempts BETWEEN 0 AND 6),
  request_record_next_retry_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surplusintelligence_chat_history_attempt_fk FOREIGN KEY (chat_history_id, attempt_id)
    REFERENCES experience.chat_generation_attempts(chat_history_id, id) ON DELETE CASCADE);
GRANT ALL ON ALL TABLES IN SCHEMA experience TO service_role;
-- Stand-ins for the production JSON helpers (their validation is not what this change touches).
CREATE FUNCTION experience.merge_surplus_call_metadata(p_old jsonb, p_new jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE
AS $$ SELECT COALESCE(p_old, '{}'::jsonb) || COALESCE(p_new, '{}'::jsonb) $$;
CREATE FUNCTION experience.surplus_call_json_safe(p_value jsonb, p_request boolean DEFAULT false) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
SET check_function_bodies = off;
CREATE FUNCTION experience.prepare_surplusintelligence_call(p_history_id uuid, p_attempt_id uuid, p_request_parameters jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fx$
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
$fx$;
CREATE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p_patch jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fx$
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
$fx$;
CREATE FUNCTION experience.claim_surplusintelligence_request_record(p_history_id uuid, p_now timestamp with time zone) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fx$
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
$fx$;
GRANT EXECUTE ON FUNCTION experience.prepare_surplusintelligence_call(uuid, uuid, jsonb),
  experience.record_surplusintelligence_call(uuid, jsonb),
  experience.claim_surplusintelligence_request_record(uuid, timestamptz) TO service_role;
SQL

check "fixture functions are the production bodies" <<'SQL'
SELECT bool_and(md5(p.prosrc) = e.m) AND count(*) = 3 FROM (VALUES
  ('experience.prepare_surplusintelligence_call(uuid,uuid,jsonb)'::regprocedure, '35245d691e80b9df2b18c53744492084'),
  ('experience.record_surplusintelligence_call(uuid,jsonb)'::regprocedure, 'e92f706b2ff33712fdc5d2bca17877e7'),
  ('experience.claim_surplusintelligence_request_record(uuid,timestamptz)'::regprocedure, '55a342d8fd095c22e9a2f75836277df4')
) e(fn, m) JOIN pg_proc p ON p.oid = e.fn;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION test_fixture.id(p_kind text, p_tag text) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $$ SELECT md5(p_kind || ':' || p_tag)::uuid $$;
GRANT EXECUTE ON FUNCTION test_fixture.id(text, text) TO service_role;
CREATE FUNCTION test_fixture.turn(p_tag text, p_age interval) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO experience.chat_history(id, user_id, model, status, created_at)
  VALUES (test_fixture.id('h', p_tag), md5('u')::uuid, 'free-m', 'streaming', now() - p_age);
  INSERT INTO experience.chat_generation_requests(chat_history_id) VALUES (test_fixture.id('h', p_tag));
  INSERT INTO experience.chat_generation_attempts VALUES (test_fixture.id('a', p_tag), test_fixture.id('h', p_tag),
    'primary', 'surplus', 'vendor/m', NULL);
END $$;
GRANT EXECUTE ON FUNCTION test_fixture.turn(text, interval) TO service_role;
-- Rows that exist before the expand.
SELECT test_fixture.turn(t, interval '1 hour') FROM unnest(ARRAY['old_done','old_pending','old_null_attempt']) t;
SELECT experience.prepare_surplusintelligence_call(test_fixture.id('h','old_done'), test_fixture.id('a','old_done'), '{"model":"vendor/m","stream":true}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','old_done'), '{"generation_id":"g-old","request_id":"r-old",
  "call_status":"completed","buyer_cost_micro":"1234","usage_usd":"0.0015","prompt_tokens":"900","total_tokens":"1000",
  "cached_tokens":"300","provider_name":"Prov","request_record_status":"complete",
  "response_metadata":{"request_record":{"data":{"request_id":"r-old"}}},"metadata_capture_status":"complete"}');
SELECT experience.prepare_surplusintelligence_call(test_fixture.id('h','old_pending'), test_fixture.id('a','old_pending'), '{"model":"vendor/m","stream":true}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','old_pending'), '{"request_id":"r-pend","call_status":"failed"}');
SELECT experience.prepare_surplusintelligence_call(test_fixture.id('h','old_null_attempt'), NULL, '{"model":"vendor/m","stream":false}');
SQL

"${admin_psql[@]}" <"$expand_2c1" >/dev/null 2>&1 || { echo "FAIL: 6a-2c-1 expand"; exit 1; }
"${admin_psql[@]}" <"$migration" >"$task_tmp/apply.log" 2>&1 || { cat "$task_tmp/apply.log"; exit 1; }
grep -q 'p6a2c2 expand: surplus calls 3 / jobs 3 (source 3), buyer cost USD ops 0.001234' "$task_tmp/apply.log" ||
  { cat "$task_tmp/apply.log"; echo "FAIL: unexpected expand notice"; exit 1; }
echo "ok: expand applied (3 existing Surplus calls copied)"

# A projection that must be identical between the old table and ops.llm_calls + ops.llm_cost_jobs.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE VIEW test_fixture.old_shape AS
SELECT COALESCE(s.attempt_id, s.id) AS id, s.attempt_id, s.chat_history_id, s.generation_id, s.request_id, s.provider_name,
  s.model, s.finish_reason, s.call_status, s.error_code, s.http_status, s.prompt_tokens, s.completion_tokens,
  s.total_tokens, s.cached_tokens, s.reasoning_tokens, s.buyer_cost_micro / 1000000 AS cost_usd, s.usage_usd,
  s.latency_ms, s.generation_time_ms, s.request_parameters, s.response_metadata, s.metadata_capture_status,
  s.request_record_status, s.request_record_attempts, s.request_record_next_retry_at, s.created_at, s.updated_at
FROM experience.surplusintelligence_chat_history s;
CREATE VIEW test_fixture.new_shape AS
SELECT l.id, l.attempt_id, l.chat_history_id, l.generation_id, l.request_id, l.provider_name, l.model, l.finish_reason,
  l.call_status, l.error_code, l.http_status, l.prompt_tokens, l.completion_tokens, l.total_tokens, l.cached_tokens,
  l.reasoning_tokens, l.cost_usd, l.reported_cost_usd, l.latency_ms, l.generation_time_ms, l.raw_request, l.raw_usage,
  l.capture_status, j.status, j.attempts, j.next_retry_at, l.created_at, l.updated_at
FROM ops.llm_calls l JOIN ops.llm_cost_jobs j ON j.call_id = l.id WHERE l.provider = 'surplus';
SQL
check "copy: existing rows are identical in ops (cost in USD, request record state in the jobs table)" <<'SQL'
SELECT NOT EXISTS (SELECT * FROM test_fixture.old_shape EXCEPT SELECT * FROM test_fixture.new_shape)
  AND NOT EXISTS (SELECT * FROM test_fixture.new_shape EXCEPT SELECT * FROM test_fixture.old_shape)
  AND (SELECT cost_source = 'surplus_buyer' AND cost_usd = 0.001234 FROM ops.llm_calls WHERE request_id = 'r-old')
  AND (SELECT id = test_fixture.id('a','old_pending') FROM ops.llm_calls WHERE request_id = 'r-pend')
  AND (SELECT attempt_id IS NULL FROM ops.llm_calls WHERE chat_history_id = test_fixture.id('h','old_null_attempt'));
SQL

# Writes after the expand go through the unchanged production functions and must be mirrored in the same transaction.
"${admin_psql[@]}" >/dev/null <<'SQL'
SELECT test_fixture.turn(t, interval '10 minutes') FROM unnest(ARRAY['new_a','new_b','new_stale','new_fresh','new_future','new_maxed']) t;
SET ROLE service_role;
SELECT experience.prepare_surplusintelligence_call(test_fixture.id('h', t), test_fixture.id('a', t), '{"model":"vendor/m","stream":true}')
FROM unnest(ARRAY['new_a','new_b','new_stale','new_fresh','new_future','new_maxed']) t;
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_a'), '{"generation_id":"g-a","request_id":"r-a",
  "call_status":"completed","buyer_cost_micro":"500","latency_ms":"120","response_metadata":{"body":{"x":1}},"metadata_capture_status":"partial"}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_a'), '{"buyer_cost_micro":"999","call_status":"failed"}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_b'), '{"request_id":"r-b","call_status":"interrupted"}');
SELECT experience.claim_surplusintelligence_request_record(test_fixture.id('h','new_b'), now());
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_stale'), '{"request_id":"r-stale","call_status":"dispatched"}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_fresh'), '{"request_id":"r-fresh","call_status":"dispatched"}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_future'), '{"request_id":"r-future","call_status":"completed",
  "request_record_next_retry_at":"2999-01-01T00:00:00Z"}');
SELECT experience.record_surplusintelligence_call(test_fixture.id('h','new_maxed'), '{"request_id":"r-maxed","call_status":"completed",
  "request_record_attempts":6}');
RESET ROLE;
UPDATE experience.surplusintelligence_chat_history SET updated_at = now() - interval '5 minutes'
WHERE chat_history_id = test_fixture.id('h','new_stale');
SQL
check "mirror: every later write through the production functions is reflected exactly" <<'SQL'
SELECT (SELECT count(*) FROM test_fixture.old_shape) = 9
  AND NOT EXISTS (SELECT * FROM test_fixture.old_shape EXCEPT SELECT * FROM test_fixture.new_shape)
  AND NOT EXISTS (SELECT * FROM test_fixture.new_shape EXCEPT SELECT * FROM test_fixture.old_shape)
  AND (SELECT cost_usd = 0.0005 AND call_status = 'completed' AND capture_status = 'partial' FROM ops.llm_calls WHERE request_id = 'r-a')
  AND (SELECT j.attempts = 1 AND j.next_retry_at > now() FROM ops.llm_cost_jobs j JOIN ops.llm_calls l ON l.id = j.call_id WHERE l.request_id = 'r-b');
SQL

check "read_surplus_call: request parameters and call id; response metadata only on request" <<'SQL'
SELECT (SELECT attempt_id = test_fixture.id('a','new_a') AND request_parameters = '{"model":"vendor/m","stream":true}'
     AND generation_id = 'g-a' AND response_metadata IS NULL FROM experience.read_surplus_call(test_fixture.id('h','new_a')))
  AND (SELECT response_metadata = '{"body":{"x":1}}' FROM experience.read_surplus_call(test_fixture.id('h','new_a'), true))
  AND NOT EXISTS (SELECT 1 FROM experience.read_surplus_call(md5('nope')::uuid));
SQL
check "candidates: exactly what the old PostgREST scan selected" <<'SQL'
WITH old_scan AS (
  SELECT chat_history_id, request_id, generation_id, call_status, request_record_attempts, request_record_next_retry_at
  FROM experience.surplusintelligence_chat_history
  WHERE request_id IS NOT NULL AND request_record_status = 'pending' AND request_record_attempts < 6
    AND (call_status IN ('completed','failed','interrupted','unknown')
      OR (call_status IN ('prepared','dispatched') AND updated_at <= now() - interval '120 seconds'))
    AND created_at >= now() - interval '24 hours'
    AND (request_record_next_retry_at IS NULL OR request_record_next_retry_at <= now())
), new_scan AS (
  SELECT * FROM experience.list_surplus_request_record_candidates(now() - interval '24 hours', 50, now())
)
SELECT (SELECT count(*) FROM old_scan) = 3
  AND NOT EXISTS (SELECT * FROM old_scan EXCEPT SELECT * FROM new_scan)
  AND NOT EXISTS (SELECT * FROM new_scan EXCEPT SELECT * FROM old_scan);
SQL
check "only service_role may call the RPCs; browser roles cannot read the jobs table" <<'SQL'
SELECT bool_and(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', f, 'EXECUTE'))
  AND NOT has_table_privilege('anon', 'ops.llm_cost_jobs', 'SELECT')
  AND NOT has_function_privilege('anon', 'ops.mirror_surplus_call()', 'EXECUTE')
FROM unnest(ARRAY['experience.read_surplus_call(uuid,boolean)',
  'experience.list_surplus_request_record_candidates(timestamptz,integer,timestamptz)']) f;
SQL

before=$("${admin_psql[@]}" -At -c "SELECT count(*) || ':' || md5(string_agg(n::text, ',' ORDER BY n.id)) FROM test_fixture.new_shape n")
"${admin_psql[@]}" <"$migration" >/dev/null 2>&1
after=$("${admin_psql[@]}" -At -c "SELECT count(*) || ':' || md5(string_agg(n::text, ',' ORDER BY n.id)) FROM test_fixture.new_shape n")
[[ "$after" == "$before" ]] || { echo "FAIL: rerun changed the mirrored rows ($before -> $after)"; exit 1; }
echo "ok: rerun copies nothing twice"
echo "PASS: p6a2c2 surplus expand"
