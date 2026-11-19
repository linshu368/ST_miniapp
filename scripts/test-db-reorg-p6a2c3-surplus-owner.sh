#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c3_surplus_owner_fix.sql as a NON-superuser:
# - fixtures are the production bodies of prepare / record / claim / read_surplus_call (md5 checked);
# - on a free-zone turn with the row representing the attempt plus two parallel Surplus slot rows, the original
#   record_surplusintelligence_call fails with P0003 (too many rows) and read_surplus_call returns 3 rows; after the
#   fix record updates only the attempt row and read returns exactly that row;
# - the facts-view join counts each turn once; md5s after the fix; rerun is a no-op; a drifted function is refused.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2c3_surplus_owner_fix.sql"
task_container="st-db-reorg-p6a2c3s-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE DATABASE fixture OWNER app_admin;
SQL
psql_f() { docker exec -i "$task_container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 "$@"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, ops, miniapp_analytics CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA ops; CREATE SCHEMA miniapp_analytics;
-- referenced by %ROWTYPE declarations (validated when the patched functions are re-created)
CREATE TABLE experience.chat_history (id uuid PRIMARY KEY, status text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL, role text NOT NULL, provider text NOT NULL,
  provider_model_id text NOT NULL, generation_id text);
-- ops.llm_calls after the 6a-2c-3 expand
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY, attempt_id uuid UNIQUE, chat_history_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'venice', 'surplus')),
  generation_id text, request_id text, provider_name text, model text, finish_reason text, call_status text,
  error_code text, http_status integer, prompt_tokens bigint, completion_tokens bigint, cached_tokens bigint,
  reasoning_tokens bigint, cost_usd numeric, cache_cost_usd numeric, cost_source text, latency_ms numeric,
  generation_time_ms numeric, raw_request jsonb, raw_usage jsonb, discarded_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  total_tokens bigint, reported_cost_usd numeric, capture_status text,
  lane text NOT NULL DEFAULT 'chat', role text, slot smallint, candidate_id text, dispatched_at timestamptz, end_reason text,
  CONSTRAINT llm_calls_attempt_is_id CHECK (attempt_id IS NULL OR attempt_id = id));
CREATE UNIQUE INDEX llm_calls_surplus_attempt_turn_idx ON ops.llm_calls (chat_history_id)
  WHERE provider = 'surplus' AND attempt_id IS NOT NULL;
CREATE TABLE ops.llm_cost_jobs (
  call_id uuid PRIMARY KEY REFERENCES ops.llm_calls(id) ON DELETE CASCADE, kind text NOT NULL, status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, next_retry_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION experience.merge_surplus_call_metadata(p_old jsonb, p_new jsonb) RETURNS jsonb LANGUAGE sql
  AS $f$ SELECT COALESCE(p_old, '{}'::jsonb) || COALESCE(p_new, '{}'::jsonb) $f$;
CREATE FUNCTION experience.surplus_call_json_safe(p jsonb) RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$;
-- free-zone turn T: the row representing the attempt + two parallel Surplus slot rows
INSERT INTO experience.chat_generation_attempts VALUES
  ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0000-000000000001', 'primary', 'surplus', 's/m', NULL);
INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, model, raw_request, lane, slot) VALUES
  ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0000-000000000001',
   'surplus', 's/m', '{"model":"s/m"}', 'free_zone', 2),
  ('00000000-0000-0000-0002-000000000001', NULL, '00000000-0000-0000-0000-000000000001', 'surplus', 's/m', NULL, 'free_zone', 0),
  ('00000000-0000-0000-0002-000000000002', NULL, '00000000-0000-0000-0000-000000000001', 'surplus', 's/m', NULL, 'free_zone', 1);
INSERT INTO ops.llm_cost_jobs (call_id, kind, status) VALUES ('00000000-0000-0000-0001-000000000001', 'surplus_request_record', 'pending');
-- facts-view shape: one row per turn joined to its Surplus call (production join text)
CREATE TABLE miniapp_analytics.turns (chat_history_id uuid PRIMARY KEY);
INSERT INTO miniapp_analytics.turns VALUES ('00000000-0000-0000-0000-000000000001');
CREATE VIEW miniapp_analytics.free_zone_turn_facts AS
SELECT f.chat_history_id, s.cost_usd AS buyer_cost_usd
  FROM miniapp_analytics.turns f
  LEFT JOIN ops.llm_calls s ON s.chat_history_id = f.chat_history_id AND s.provider = 'surplus';
SET check_function_bodies = off;
SQL
  psql_f >/dev/null <<'SQL'
SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION experience.prepare_surplusintelligence_call(p_history_id uuid, p_attempt_id uuid, p_request_parameters jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $prodfn$
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
$prodfn$;
CREATE OR REPLACE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $prodfn$
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
$prodfn$;
CREATE OR REPLACE FUNCTION experience.claim_surplusintelligence_request_record(p_history_id uuid, p_now timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $prodfn$
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
$prodfn$;
CREATE OR REPLACE FUNCTION experience.read_surplus_call(p_history_id uuid, p_with_metadata boolean DEFAULT false)
 RETURNS TABLE(attempt_id uuid, request_parameters jsonb, generation_id text, response_metadata jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $prodfn$
  SELECT l.attempt_id, l.raw_request, l.generation_id, CASE WHEN p_with_metadata THEN l.raw_usage END
  FROM ops.llm_calls l
  WHERE l.chat_history_id = p_history_id AND l.provider = 'surplus'
$prodfn$;
SQL
}

fixture
check 'fixtures are the production bodies' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['ae299e95636d78e16da61ec8e6abf628','ad7fd34513e437ef05aa0cb9c8c41316',
  'd043b371d45b7f3e733fd48ee2c557f3','4e4ebff722e9e39b6beb7ea5fa7114d2']
FROM pg_proc WHERE proname IN ('claim_surplusintelligence_request_record','prepare_surplusintelligence_call','read_surplus_call','record_surplusintelligence_call');
SQL
if out=$(psql_f -c "SELECT experience.record_surplusintelligence_call('00000000-0000-0000-0000-000000000001', '{\"generation_id\":\"gen-1\"}')" 2>&1); then
  echo 'FAIL: original record did not fail on parallel slot rows'; exit 1
fi
[[ "$out" == *'more than one row'* ]] || { echo "FAIL: unexpected original error: $out"; exit 1; }
echo 'ok: original record fails with too many rows (the production P0003)'
check 'before: read returns all three Surplus rows and the facts view repeats the turn' <<'SQL'
SELECT (SELECT count(*) FROM experience.read_surplus_call('00000000-0000-0000-0000-000000000001')) = 3
  AND (SELECT count(*) FROM miniapp_analytics.free_zone_turn_facts) = 3;
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'5 objects now use the row representing the attempt'* ]] || { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: four functions and the facts view patched'
check 'md5s after the fix' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['1fed2a01d53c8bea8e92926d7043f374','e2c9d9be3245477ce5c8284a253aca80',
  '30b2e0080fbb19e078098761a5275592','0ecc825eb7edba88b5c2d8d9e99f3f90']
FROM pg_proc WHERE proname IN ('claim_surplusintelligence_request_record','prepare_surplusintelligence_call','read_surplus_call','record_surplusintelligence_call');
SQL
psql_f -c "SELECT experience.record_surplusintelligence_call('00000000-0000-0000-0000-000000000001', '{\"generation_id\":\"gen-1\"}')" >/dev/null
check 'after: record updates only the attempt row; read returns exactly it; facts view one row per turn' <<'SQL'
SELECT (SELECT generation_id FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000001') = 'gen-1'
  AND (SELECT count(*) FROM ops.llm_calls WHERE attempt_id IS NULL AND generation_id IS NOT NULL) = 0
  AND (SELECT array_agg(attempt_id) FROM experience.read_surplus_call('00000000-0000-0000-0000-000000000001'))
      = ARRAY['00000000-0000-0000-0001-000000000001'::uuid]
  AND (SELECT count(*) FROM miniapp_analytics.free_zone_turn_facts) = 1;
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'0 objects now use the row representing the attempt'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun is a no-op'

fixture
psql_f >/dev/null <<'SQL'
DO $d$ BEGIN
  EXECUTE replace(pg_get_functiondef('experience.claim_surplusintelligence_request_record(uuid,timestamptz)'::regprocedure),
                  'FOR UPDATE;', 'FOR UPDATE ;');
END $d$;
SQL
if out=$(psql_f <"$migration" 2>&1); then echo 'FAIL: drifted function not refused'; exit 1; fi
[[ "$out" == *'drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'refusal changed nothing' <<'SQL'
SELECT md5(prosrc) = 'ad7fd34513e437ef05aa0cb9c8c41316' FROM pg_proc WHERE proname = 'prepare_surplusintelligence_call';
SQL
echo 'all checks passed'
