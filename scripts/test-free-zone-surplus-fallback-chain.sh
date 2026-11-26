#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Whole first-token chain for a free-zone turn rescued by the Surplus fallback, on the 2026-11-26 production
# bodies of every function it calls (md5 checked): begin → prepare fallback → observe both → delivery preview →
# select delivery → client first-token report. Runs as a NON-superuser.
# - state before 20261126_free_zone_surplus_fallback_begin.sql = production right now (first migration applied):
#   begin rejects the Surplus fallback model name (the 2026-11-26 14:02 incident);
# - after: the whole chain succeeds, the quote binds the Surplus fallback, the primary's Surplus row is untouched;
#   a paid turn with the OpenRouter fallback still works; malformed names are still rejected;
# - rerun is a no-op; a drifted begin function is refused.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$root/scripts/fixtures-free-zone-fallback-chain.sql"
first="$root/packages/shared/migrations/20261126_free_zone_surplus_fallback.sql"
migration="$root/packages/shared/migrations/20261126_free_zone_surplus_fallback_begin.sql"
container="st-fz-fallback-chain-${RANDOM}-$$"
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
run() { psql_f >/dev/null 2>&1 <"$1"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
md5_of() { psql_f -At -c "SELECT md5(replace(pg_get_functiondef('$1'::regprocedure), E'\r\n', E'\n'))"; }

H1=a0000000-0000-0000-0000-000000000001 # free-zone turn, Surplus fallback wins
H2=a0000000-0000-0000-0000-000000000002 # paid turn, OpenRouter fallback wins
seed() {
  psql_f >/dev/null <<SQL
INSERT INTO billing.usage_charges (id) VALUES ('c0000000-0000-0000-0000-000000000001'), ('c0000000-0000-0000-0000-000000000002');
INSERT INTO experience.chat_history VALUES
  ('$H1', 'e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 3, 1, 'streaming', NULL, NULL),
  ('$H2', 'e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 4, 1, 'streaming', NULL, NULL);
SQL
}
begin_input() { # history request primary provider model fallback deadline charge
  cat <<JSON
{"request_id":"$2","primary_attempt_id":"$3","requested_model_id":"m","provider":"$4","model":"$5",
 "received_at":"2026-11-26T06:30:00Z","fallback_model_id":"$6","timeout_ms":6000,"fallback_timeout_ms":2000,
 "deadline_ms":$7,"timeout_rate_target":0.02,"catalog_version":125,"mode":"send","charge_id":"$8",
 "snapshot":{"charge_id":"$8","provider":"$4","provider_model_id":"$5","free_zone":true},
 "history":[{"role":"system","content":"","request_id":"$2"},{"role":"user","content":"你好"}],
 "recoverable_delivery":true,"measurement_method":"client_committed_v4"}
JSON
}
begin_sql() { echo "SELECT experience.begin_chat_generation_observation('$1', \$j\$$(begin_input "$@")\$j\$::jsonb);"; }

# ---- fixtures match production
psql_f >/dev/null 2>&1 <"$fixture"
check "begin matches production" <<<"SELECT '$(md5_of 'experience.begin_chat_generation_observation(uuid,jsonb)')' = 'a2827dea57ffca6f95d0a82d15c79753'"
check "observe matches production" <<<"SELECT '$(md5_of 'experience.observe_chat_generation_attempt(uuid,jsonb)')' = 'dfc2660768e9dae75e5e2ec7a70f7b4e'"
check "delivery preview matches production" <<<"SELECT '$(md5_of 'experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)')' = '97b95292e697132ca73b535cc568e451'"
check "first-token report matches production" <<<"SELECT '$(md5_of 'experience.report_chat_first_token(uuid,uuid,jsonb)')' = '350609cb9e92730473ca84ec4ad5bc3b'"
run "$first"
check "after the first migration prepare(4) matches production" <<<"SELECT '$(md5_of 'experience.prepare_chat_generation_fallback(uuid,uuid,numeric,text)')' = '4349f5b64477322de540801c49a991e1'"
check "after the first migration delivery matches production" <<<"SELECT '$(md5_of 'experience.select_chat_generation_delivery(uuid,uuid,text)')' = 'd4fd5b5f10acccf83875929b548f6810'"

# ---- before the fix: the incident
seed
check "before: begin rejects the Surplus fallback name with 22023" <<SQL
DO \$t\$ BEGIN
  $(begin_sql $H1 b1000000-0000-0000-0000-000000000001 b0000000-0000-0000-0000-000000000001 surplus gemini-3-flash-preview deepseek-v4.1-flash-1017 11000 c0000000-0000-0000-0000-000000000001 | sed 's/^SELECT/PERFORM/')
  RAISE EXCEPTION 'not rejected';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END \$t\$;
SELECT NOT EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id = '$H1');
SQL

# ---- after the fix: the whole chain
run "$migration"
psql_f >/dev/null <<SQL
$(begin_sql $H1 b1000000-0000-0000-0000-000000000001 b0000000-0000-0000-0000-000000000001 surplus gemini-3-flash-preview deepseek-v4.1-flash-1017 11000 c0000000-0000-0000-0000-000000000001)
SELECT experience.prepare_chat_generation_fallback('$H1', 'f0000000-0000-0000-0000-000000000001', 6050, 'surplus');
SELECT experience.observe_chat_generation_attempt('$H1', '{"id":"b0000000-0000-0000-0000-000000000001","role":"primary","provider":"surplus","model":"gemini-3-flash-preview","dispatched_at":"2026-11-26T06:30:00.100Z","dispatch_offset_ms":100,"observed_until_ms":6400,"end_reason":"cancelled"}');
SELECT experience.observe_chat_generation_attempt('$H1', '{"id":"f0000000-0000-0000-0000-000000000001","role":"fallback","provider":"surplus","model":"deepseek-v4.1-flash-1017","generation_id":"gen-fb","dispatched_at":"2026-11-26T06:30:06.100Z","dispatch_offset_ms":6050,"first_token_ms":1800,"observed_until_ms":1800,"end_reason":"first_token_observed"}');
SELECT experience.record_chat_delivery_preview('$H1', 1, 7900, 'delta', '兜底');
SELECT experience.select_chat_generation_delivery('$H1', 'f0000000-0000-0000-0000-000000000001', 'gen-fb');
SELECT experience.report_chat_first_token('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
  '{"assistant_message_id":"$H1","revision":1,"request_id":"b1000000-0000-0000-0000-000000000001","outcome":"observed","first_token_visible_ms":8100,"measurement_method":"client_committed_v4","backgrounded":false}');
SQL
check "free-zone turn: request frozen with the Surplus fallback" <<<"SELECT fallback_model_id = 'deepseek-v4.1-flash-1017' AND delivery_attempt_id = 'f0000000-0000-0000-0000-000000000001' AND client_outcome = 'observed' AND first_token_preview->>'text' = '兜底' FROM experience.chat_generation_requests WHERE chat_history_id = '$H1'"
check "free-zone turn: both attempts observed with their own routes" <<'SQL'
SELECT count(*) = 2
  AND bool_and((role = 'primary' AND provider = 'surplus' AND end_reason = 'cancelled')
            OR (role = 'fallback' AND provider = 'surplus' AND provider_model_id = 'deepseek-v4.1-flash-1017'
                AND generation_id = 'gen-fb' AND end_reason = 'first_token_observed'))
FROM experience.chat_generation_attempts WHERE chat_history_id = 'a0000000-0000-0000-0000-000000000001'
SQL
check "free-zone turn: quote bound to the Surplus fallback, primary's Surplus row untouched" <<SQL
SELECT u.quote->'snapshot'->>'provider' = 'surplus' AND u.quote->'snapshot'->>'provider_model_id' = 'deepseek-v4.1-flash-1017'
  AND NOT EXISTS (SELECT 1 FROM experience.surplus_row_writes WHERE history_id = '$H1')
FROM billing.usage_charges u WHERE u.id = 'c0000000-0000-0000-0000-000000000001'
SQL
psql_f >/dev/null <<SQL
$(begin_sql $H2 b1000000-0000-0000-0000-000000000002 b0000000-0000-0000-0000-000000000002 openrouter google/gemini-3-flash-preview deepseek/deepseek-v4.1-flash-1017 8000 c0000000-0000-0000-0000-000000000002)
SELECT experience.prepare_chat_generation_fallback('$H2', 'f0000000-0000-0000-0000-000000000002', 4050);
SELECT experience.observe_chat_generation_attempt('$H2', '{"id":"f0000000-0000-0000-0000-000000000002","role":"fallback","provider":"openrouter","model":"deepseek/deepseek-v4.1-flash-1017","generation_id":"gen-or","end_reason":"first_token_observed"}');
SELECT experience.select_chat_generation_delivery('$H2', 'f0000000-0000-0000-0000-000000000002', 'gen-or');
SQL
check "paid turn: OpenRouter fallback chain unchanged" <<SQL
SELECT r.fallback_model_id = 'deepseek/deepseek-v4.1-flash-1017' AND a.provider = 'openrouter'
  AND r.delivery_attempt_id = a.id
FROM experience.chat_generation_requests r JOIN experience.chat_generation_attempts a
  ON a.chat_history_id = r.chat_history_id AND a.role = 'fallback'
WHERE r.chat_history_id = '$H2'
SQL
for bad in 'deepseek v4' '-flash' 'a/b c' '../etc'; do
  check "begin still rejects the malformed name '$bad'" <<SQL
INSERT INTO experience.chat_history VALUES ('a0000000-0000-0000-0000-0000000000ff', 'e0000000-0000-0000-0000-000000000001', NULL, NULL, NULL, 'streaming', NULL, NULL);
DO \$t\$ BEGIN
  PERFORM experience.begin_chat_generation_observation('a0000000-0000-0000-0000-0000000000ff',
    jsonb_build_object('request_id','b1000000-0000-0000-0000-0000000000ff','primary_attempt_id','b0000000-0000-0000-0000-0000000000ff',
      'requested_model_id','m','provider','surplus','model','x','received_at','2026-11-26T06:30:00Z','fallback_model_id','$bad',
      'timeout_ms',6000,'fallback_timeout_ms',2000,'deadline_ms',11000,'timeout_rate_target',0.02,'catalog_version',1,'mode','send'));
  RAISE EXCEPTION 'not rejected';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END \$t\$;
DELETE FROM experience.chat_history WHERE id = 'a0000000-0000-0000-0000-0000000000ff';
SELECT true;
SQL
done
before_rerun=$(md5_of 'experience.begin_chat_generation_observation(uuid,jsonb)')
run "$migration"
check "rerun is a no-op" <<<"SELECT '$(md5_of 'experience.begin_chat_generation_observation(uuid,jsonb)')' = '$before_rerun'"

# ---- drifted begin is refused
psql_f >/dev/null 2>&1 <"$fixture"
psql_f >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
 RETURNS void LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$ BEGIN RETURN; END; $function$;
SQL
if run "$migration"; then echo "FAIL: drifted begin function was not refused"; exit 1; fi
echo "ok: drifted begin function refused"
echo "all checks passed"
