#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c1_llm_calls_expand.sql as a NON-superuser with CREATEROLE:
# - every OpenRouter / Venice detail row is copied once: rows whose identity matches the delivered attempt take the
#   attempt id, older rows keep their own id with attempt_id NULL; Venice micro-USD becomes USD; junk numbers drop;
# - record_llm_call_metadata locates the call by (turn, generation_id), only fills empty values, scales Venice, and
#   refuses unknown identities, Surplus calls and malformed input;
# - read_llm_call_metadata returns the delivered OpenRouter call under the old detail-table field names;
# - list_llm_call_metadata_gaps lists finished turns whose delivered OpenRouter call lacks complete metadata, newest
#   first, capped at 50;
# - only service_role may use the RPCs or the table; a rerun copies nothing twice.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2c1_llm_calls_expand.sql"
task_container="st-db-reorg-p6a2c1-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
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

# Fixture: production shapes (2026-11-19) of the tables this change reads.
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
  UNIQUE (chat_history_id, role));
CREATE TABLE experience.openrouter_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_history_id uuid NOT NULL UNIQUE REFERENCES experience.chat_history(id),
  llm_generation_id text, llm_generation_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), provider_name text, finish_reason text, usage jsonb, usage_cache jsonb,
  native_tokens_cached integer, native_tokens_reasoning integer, native_tokens_completion integer,
  native_tokens_prompt integer, latency numeric, generation_time numeric, model text);
CREATE TABLE experience.venice_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_history_id uuid NOT NULL UNIQUE REFERENCES experience.chat_history(id),
  llm_provider_name text NOT NULL DEFAULT 'venice', llm_finish_reason text, llm_usage jsonb, llm_usage_cache jsonb,
  llm_native_tokens_cached integer, llm_native_tokens_reasoning integer, llm_native_tokens_completion integer,
  llm_native_tokens_prompt integer, llm_latency numeric, llm_generation_time numeric, llm_model text,
  llm_generation_id text, llm_generation_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON ALL TABLES IN SCHEMA experience TO service_role;

CREATE FUNCTION test_fixture.id(p_kind text, p_tag text) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $$ SELECT md5(p_kind || ':' || p_tag)::uuid $$;
GRANT EXECUTE ON FUNCTION test_fixture.id(text, text) TO service_role;
-- A turn with a request; optionally a delivered attempt of a provider with a generation id.
CREATE FUNCTION test_fixture.turn(p_tag text, p_age interval, p_status text, p_provider text, p_generation text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO experience.chat_history(id, user_id, model, status, created_at)
  VALUES (test_fixture.id('h', p_tag), md5('u')::uuid, 'm', p_status, now() - p_age);
  INSERT INTO experience.chat_generation_requests(chat_history_id) VALUES (test_fixture.id('h', p_tag));
  IF p_provider IS NOT NULL THEN
    INSERT INTO experience.chat_generation_attempts VALUES (test_fixture.id('a', p_tag), test_fixture.id('h', p_tag),
      'primary', p_provider, 'm', p_generation);
    UPDATE experience.chat_generation_requests SET delivery_attempt_id = test_fixture.id('a', p_tag)
    WHERE chat_history_id = test_fixture.id('h', p_tag);
  END IF;
END $$;
SELECT test_fixture.turn('or_full',  '50 minutes', 'success', 'openrouter', 'g-full');
SELECT test_fixture.turn('or_part',  '40 minutes', 'success', 'openrouter', 'g-part');
SELECT test_fixture.turn('or_none',  '30 minutes', 'success', 'openrouter', 'g-none');
SELECT test_fixture.turn('or_stream','20 minutes', 'streaming', 'openrouter', 'g-stream');
SELECT test_fixture.turn('or_old',   '30 hours',   'success', 'openrouter', 'g-old');
SELECT test_fixture.turn('legacy',   '60 days',    'success', NULL, NULL);
SELECT test_fixture.turn('ve',       '45 minutes', 'success', 'venice', 'g-ve');
SELECT test_fixture.turn('sp',       '35 minutes', 'success', 'surplus', 'g-sp');
INSERT INTO experience.openrouter_chat_history(id, chat_history_id, llm_generation_id, llm_generation_data, provider_name,
  finish_reason, usage, usage_cache, native_tokens_cached, native_tokens_reasoning, native_tokens_completion,
  native_tokens_prompt, latency, generation_time, model) VALUES
  (test_fixture.id('o', 'or_full'), test_fixture.id('h', 'or_full'), 'g-full', '{"id":"g-full"}', 'Vendor', 'stop',
   '0.0042', '0.001', 10, 5, 300, 9000, 800, 4100, 'vendor/x'),
  (test_fixture.id('o', 'or_part'), test_fixture.id('h', 'or_part'), 'g-part', NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (test_fixture.id('o', 'legacy'), test_fixture.id('h', 'legacy'), 'g-legacy', '{"id":"g-legacy"}', 'Old', 'length',
   '"oops"', NULL, -1, NULL, 100, 200, -5, 300, 'old/model');
INSERT INTO experience.venice_chat_history(id, chat_history_id, llm_generation_id, llm_finish_reason, llm_usage,
  llm_usage_cache, llm_native_tokens_prompt, llm_native_tokens_completion, llm_latency, llm_generation_time, llm_model,
  llm_generation_data) VALUES
  (test_fixture.id('v', 've'), test_fixture.id('h', 've'), 'g-ve', 'stop', '2519.25', '100', 22000, 400, 900, 5000,
   'venice/m', '{"usage":{}}');
SQL

"${admin_psql[@]}" <"$migration" >/dev/null 2>"/tmp/p6a2c1-apply-$$.log" || { cat "/tmp/p6a2c1-apply-$$.log"; exit 1; }
grep -q 'p6a2c1 expand: ops.llm_calls openrouter 3 (detail 3), venice 1 (detail 1), attempt-linked 3' "/tmp/p6a2c1-apply-$$.log" ||
  { cat "/tmp/p6a2c1-apply-$$.log"; echo "FAIL: unexpected expand notice"; exit 1; }
rm -f "/tmp/p6a2c1-apply-$$.log"
echo "ok: expand applied (3 OpenRouter + 1 Venice rows copied, 3 linked to attempts)"

check "copy: delivered rows take the attempt id, a pre-attempt row keeps its own id, Venice is USD, junk is dropped" <<'SQL'
SELECT
  (SELECT attempt_id = id AND id = test_fixture.id('a', 'or_full') AND cost_usd = 0.0042 AND cache_cost_usd = 0.001
     AND prompt_tokens = 9000 AND latency_ms = 800 AND raw_usage = '{"id":"g-full"}' AND cost_source = 'openrouter_usage'
   FROM ops.llm_calls WHERE generation_id = 'g-full')
  AND (SELECT attempt_id = id AND cost_usd IS NULL AND raw_usage IS NULL FROM ops.llm_calls WHERE generation_id = 'g-part')
  AND (SELECT attempt_id IS NULL AND id = test_fixture.id('o', 'legacy') AND cost_usd IS NULL AND cost_source IS NULL
     AND cached_tokens IS NULL AND latency_ms IS NULL AND completion_tokens = 100 AND finish_reason = 'length'
   FROM ops.llm_calls WHERE generation_id = 'g-legacy')
  AND (SELECT attempt_id = test_fixture.id('a', 've') AND provider = 'venice' AND cost_usd = 0.00251925
     AND cache_cost_usd = 0.0001 AND cost_source = 'venice_usage' FROM ops.llm_calls WHERE generation_id = 'g-ve');
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.errors (tag text PRIMARY KEY, sqlstate text);
GRANT INSERT ON test_fixture.errors TO service_role;
CREATE FUNCTION test_fixture.try_record(p_tag text, p_history uuid, p_generation text, p_metadata jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM experience.record_llm_call_metadata(p_history, p_generation, p_metadata);
  INSERT INTO test_fixture.errors VALUES (p_tag, 'ok');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO test_fixture.errors VALUES (p_tag, SQLSTATE);
END $$;
GRANT EXECUTE ON FUNCTION test_fixture.try_record(text, uuid, text, jsonb) TO service_role;
SET ROLE service_role;
-- Fill the partial row, then try to overwrite a complete one.
SELECT test_fixture.try_record('fill', test_fixture.id('h', 'or_part'), 'g-part', '{"provider_name":"Vendor B",
  "finish_reason":"stop","usage":0.01,"latency":500,"generation_time":2000,"native_tokens_prompt":100,
  "llm_generation_data":{"id":"g-part"}}');
SELECT test_fixture.try_record('no_overwrite', test_fixture.id('h', 'or_full'), 'g-full', '{"finish_reason":"length",
  "usage":9,"model":"other"}');
SELECT test_fixture.try_record('new_row', test_fixture.id('h', 'or_none'), 'g-none', '{"usage":0.002,"latency":1,
  "generation_time":2,"finish_reason":"stop","llm_generation_data":{"id":"g-none"}}');
SELECT test_fixture.try_record('venice_new', test_fixture.id('h', 've'), 'g-ve', '{"usage_cache":50}');
SELECT test_fixture.try_record('unknown', test_fixture.id('h', 'or_full'), 'g-nope', '{}');
SELECT test_fixture.try_record('no_id_delivered', test_fixture.id('h', 've'), NULL, '{"model":"venice/m2","latency":1}');
SELECT test_fixture.try_record('no_id_undelivered', test_fixture.id('h', 'legacy'), NULL, '{}');
SELECT test_fixture.try_record('surplus', test_fixture.id('h', 'sp'), 'g-sp', '{}');
SELECT test_fixture.try_record('blank', test_fixture.id('h', 'or_full'), ' ', '{}');
SELECT test_fixture.try_record('not_object', test_fixture.id('h', 'or_full'), 'g-full', '[1]');
RESET ROLE;
SQL
check "record: fills empty values only, inserts a new call, refuses unknown / Surplus / malformed" <<'SQL'
SELECT (SELECT jsonb_object_agg(tag, sqlstate) FROM test_fixture.errors) = '{"fill":"ok","no_overwrite":"ok",
    "new_row":"ok","venice_new":"ok","unknown":"P0002","no_id_delivered":"ok","no_id_undelivered":"P0002",
    "surplus":"22023","blank":"22023","not_object":"22023"}'::jsonb
  AND (SELECT provider_name = 'Vendor B' AND cost_usd = 0.01 AND raw_usage = '{"id":"g-part"}' FROM ops.llm_calls WHERE generation_id = 'g-part')
  AND (SELECT finish_reason = 'stop' AND cost_usd = 0.0042 AND model = 'vendor/x' FROM ops.llm_calls WHERE generation_id = 'g-full')
  AND (SELECT id = test_fixture.id('a', 'or_none') AND attempt_id = id AND cost_usd = 0.002 FROM ops.llm_calls WHERE generation_id = 'g-none')
  AND (SELECT cache_cost_usd = 0.0001 AND model = 'venice/m' AND latency_ms = 900 FROM ops.llm_calls WHERE generation_id = 'g-ve');
SQL
check "read: delivered OpenRouter calls under the old field names; Venice and unknown turns are absent" <<'SQL'
SELECT (SELECT count(*) FROM experience.read_llm_call_metadata(ARRAY[test_fixture.id('h','or_full'), test_fixture.id('h','ve'),
    test_fixture.id('h','legacy'), test_fixture.id('h','sp')])) = 1
  AND (SELECT usage = 0.0042 AND usage_cache = 0.001 AND latency = 800 AND generation_time = 4100 AND native_tokens_prompt = 9000
     AND finish_reason = 'stop' AND llm_generation_data = '{"id":"g-full"}'
   FROM experience.read_llm_call_metadata(ARRAY[test_fixture.id('h','or_full')]));
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE ops.llm_calls SET latency_ms = NULL WHERE generation_id = 'g-none';
SELECT test_fixture.turn('or_missing', '10 minutes', 'stream_interrupted', 'openrouter', 'g-missing');
SQL
check "gaps: finished delivered OpenRouter turns without complete metadata, newest first" <<'SQL'
SELECT array_agg(id ORDER BY ord) = ARRAY[test_fixture.id('h','or_missing'), test_fixture.id('h','or_none')]
FROM experience.list_llm_call_metadata_gaps(now() - interval '24 hours', 50)
  WITH ORDINALITY g(id, user_id, model, session_id, llm_finish_reason, llm_charge_id, assistant_reply, status,
    llm_billing_snapshot, llm_billing_settled_at, delivery_provider, generation_id, ord);
SQL
check "only service_role may use the RPCs; the table is not readable by browser roles" <<'SQL'
SELECT bool_and(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', f, 'EXECUTE'))
  AND NOT has_table_privilege('anon', 'ops.llm_calls', 'SELECT')
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'ops.llm_calls'::regclass)
FROM unnest(ARRAY['experience.record_llm_call_metadata(uuid,text,jsonb)', 'experience.read_llm_call_metadata(uuid[])',
  'experience.list_llm_call_metadata_gaps(timestamptz,integer)']) f;
SQL
before=$("${admin_psql[@]}" -At -c "SELECT count(*) || ':' || md5(string_agg(id::text || coalesce(cost_usd::text,''), ',' ORDER BY id)) FROM ops.llm_calls")
"${admin_psql[@]}" <"$migration" >/dev/null 2>&1
after=$("${admin_psql[@]}" -At -c "SELECT count(*) || ':' || md5(string_agg(id::text || coalesce(cost_usd::text,''), ',' ORDER BY id)) FROM ops.llm_calls")
[[ "$after" == "$before" ]] || { echo "FAIL: rerun changed ops.llm_calls ($before -> $after)"; exit 1; }
echo "ok: rerun copies nothing twice and keeps recorded values"
echo "PASS: p6a2c1 llm_calls expand"
