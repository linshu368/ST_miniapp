#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261126_free_zone_surplus_fallback.sql as a NON-superuser:
# - fixtures are the 2026-11-26 production bodies of prepare_chat_generation_fallback (3 args) and
#   select_chat_generation_delivery (md5 checked);
# - before: a Surplus fallback winner writes into the primary's per-turn Surplus row;
# - after: the 4-arg prepare records a surplus fallback attempt and rejects other providers, the 3-arg one is unchanged;
#   a Surplus fallback winner leaves the Surplus row alone, a Surplus primary winner still records it;
# - rerun is a no-op; a drifted delivery function is refused; anon cannot execute the new overload.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261126_free_zone_surplus_fallback.sql"
container="st-fz-surplus-fallback-${RANDOM}-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT anon, service_role TO app_admin;
CREATE DATABASE fixture OWNER app_admin;
SQL
psql_f() { docker exec -i "$container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 "$@"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
apply() { docker exec -i "$container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 <"$migration"; }

fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, billing CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA billing;
GRANT USAGE ON SCHEMA experience TO service_role, anon;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, status text NOT NULL, llm_finish_reason text, llm_charge_id uuid);
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid PRIMARY KEY, first_token_deadline_ms numeric NOT NULL, fallback_model_id text,
  fallback_triggered_ms numeric, delivery_attempt_id uuid);
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL, role text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openrouter','venice','surplus','packy','onexmodel')),
  provider_model_id text NOT NULL, generation_id text);
CREATE TABLE billing.usage_charges (id uuid PRIMARY KEY, quote jsonb NOT NULL, updated_at timestamptz);
-- records which turns had their per-turn Surplus row written
CREATE TABLE experience.surplus_row_writes (history_id uuid, generation_id text);
CREATE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p jsonb) RETURNS void
  LANGUAGE sql AS $f$ INSERT INTO experience.surplus_row_writes VALUES (p_history_id, p->>'generation_id') $f$;

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

-- three free-zone turns: 1 Surplus fallback wins, 2 Surplus primary wins, 3 paid (OpenRouter fallback)
INSERT INTO billing.usage_charges VALUES
  ('c0000000-0000-0000-0000-000000000001', '{"snapshot":{"charge_id":"c0000000-0000-0000-0000-000000000001"}}', NULL),
  ('c0000000-0000-0000-0000-000000000002', '{"snapshot":{"charge_id":"c0000000-0000-0000-0000-000000000002"}}', NULL),
  ('c0000000-0000-0000-0000-000000000003', '{"snapshot":{"charge_id":"c0000000-0000-0000-0000-000000000003"}}', NULL);
INSERT INTO experience.chat_history VALUES
  ('a0000000-0000-0000-0000-000000000001', 'streaming', NULL, 'c0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'streaming', NULL, 'c0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003', 'streaming', NULL, 'c0000000-0000-0000-0000-000000000003');
INSERT INTO experience.chat_generation_requests (chat_history_id, first_token_deadline_ms, fallback_model_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 11000, 'deepseek-v4.1-flash-1017'),
  ('a0000000-0000-0000-0000-000000000002', 11000, 'deepseek-v4.1-flash-1017'),
  ('a0000000-0000-0000-0000-000000000003', 6000, 'deepseek/deepseek-v4.1-flash-1017');
INSERT INTO experience.chat_generation_attempts VALUES
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'primary', 'surplus', 'gemini-3-flash-preview', NULL),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'primary', 'surplus', 'gemini-3-flash-preview', NULL),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'primary', 'openrouter', 'google/gemini-3-flash-preview', NULL);
SQL
}

md5_of() { # regprocedure
  psql_f -At -c "SELECT md5(replace(pg_get_functiondef('$1'::regprocedure), E'\r\n', E'\n'))"
}

# ---- before: fixtures match production; the bug is real
fixture
check "fixture prepare matches production md5" <<<"SELECT '$(md5_of 'experience.prepare_chat_generation_fallback(uuid,uuid,numeric)')' = '48d77c3a3566f8f42dc26c3aa3f0ac1a'"
check "fixture delivery matches production md5" <<<"SELECT '$(md5_of 'experience.select_chat_generation_delivery(uuid,uuid,text)')' = '392e0acfd462e8ba599ee2b6d2efa8f4'"
psql_f >/dev/null <<'SQL'
INSERT INTO experience.chat_generation_attempts VALUES
  ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'fallback', 'surplus', 'deepseek-v4.1-flash-1017', NULL);
SELECT experience.select_chat_generation_delivery('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'gen-fallback');
SQL
check "before: a Surplus fallback winner writes into the primary's Surplus row" <<<"SELECT count(*) = 1 FROM experience.surplus_row_writes WHERE generation_id = 'gen-fallback'"

# ---- after
fixture
apply
psql_f >/dev/null <<'SQL'
SELECT experience.prepare_chat_generation_fallback('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 6100, 'surplus');
SELECT experience.prepare_chat_generation_fallback('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 6100, 'surplus');
SELECT experience.prepare_chat_generation_fallback('a0000000-0000-0000-0000-000000000003', 'f0000000-0000-0000-0000-000000000003', 2100);
SQL
check "4-arg prepare records a Surplus fallback (idempotent) with the frozen model" <<'SQL'
SELECT count(*) = 1 AND bool_and(provider = 'surplus' AND provider_model_id = 'deepseek-v4.1-flash-1017')
FROM experience.chat_generation_attempts WHERE chat_history_id = 'a0000000-0000-0000-0000-000000000001' AND role = 'fallback'
SQL
check "3-arg prepare still records an OpenRouter fallback" <<'SQL'
SELECT provider = 'openrouter' AND provider_model_id = 'deepseek/deepseek-v4.1-flash-1017'
FROM experience.chat_generation_attempts WHERE id = 'f0000000-0000-0000-0000-000000000003'
SQL
check "4-arg prepare rejects other providers" <<'SQL'
DO $t$ BEGIN
  PERFORM experience.prepare_chat_generation_fallback('a0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000002', 6100, 'venice');
  RAISE EXCEPTION 'not rejected';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END $t$;
SELECT NOT EXISTS (SELECT 1 FROM experience.chat_generation_attempts WHERE id = 'f0000000-0000-0000-0000-000000000002');
SQL
psql_f >/dev/null <<'SQL'
SELECT experience.select_chat_generation_delivery('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'gen-fallback');
SELECT experience.select_chat_generation_delivery('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'gen-primary');
SQL
check "after: a Surplus fallback winner leaves the Surplus row alone" <<<"SELECT NOT EXISTS (SELECT 1 FROM experience.surplus_row_writes WHERE history_id = 'a0000000-0000-0000-0000-000000000001')"
check "after: a Surplus primary winner still records the Surplus row" <<<"SELECT count(*) = 1 FROM experience.surplus_row_writes WHERE history_id = 'a0000000-0000-0000-0000-000000000002' AND generation_id = 'gen-primary'"
check "after: delivery binds the fallback route into the quote" <<'SQL'
SELECT quote->'snapshot'->>'provider' = 'surplus' AND quote->'snapshot'->>'provider_model_id' = 'deepseek-v4.1-flash-1017'
FROM billing.usage_charges WHERE id = 'c0000000-0000-0000-0000-000000000001'
SQL
check "new overload: service_role may execute, anon may not" <<'SQL'
SELECT has_function_privilege('service_role', 'experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text)', 'EXECUTE')
SQL
before_rerun=$(md5_of 'experience.select_chat_generation_delivery(uuid,uuid,text)')
apply
check "rerun is a no-op" <<<"SELECT '$(md5_of 'experience.select_chat_generation_delivery(uuid,uuid,text)')' = '$before_rerun'"

# ---- drifted delivery function is refused (whole transaction rolls back)
fixture
psql_f >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid, p_attempt_id uuid, p_generation_id text)
 RETURNS void LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$ BEGIN RETURN; END; $function$;
SQL
if apply >/dev/null 2>&1; then echo "FAIL: drifted delivery function was not refused"; exit 1; fi
check "drifted function refused and nothing created" <<<"SELECT to_regprocedure('experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text)') IS NULL"
echo "all checks passed"
