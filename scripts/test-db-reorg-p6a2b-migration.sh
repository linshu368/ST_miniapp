#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2b_settlement_candidates.sql as a NON-superuser with CREATEROLE:
# - each scan (openrouter / venice / surplus / missing_identity) returns exactly the turns the old embedded
#   PostgREST scans selected, with the identity of the delivered attempt (never a losing call's generation);
# - settled, unquoted, too-old, still-streaming and not-yet-stale turns are excluded; budget is capped at 50 and
#   ordered by created_at; an unknown scan returns nothing;
# - only service_role may execute it; a rerun leaves the same function.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2b_settlement_candidates.sql"
task_container="st-db-reorg-p6a2b-${RANDOM}-$$"
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

# Fixture: the columns the function reads, shaped as production after 6a-2a (2026-11-19).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT anon, authenticated, service_role TO app_admin;
CREATE SCHEMA experience; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA experience, test_fixture TO service_role;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, model text NOT NULL, session_id uuid, status text NOT NULL,
  llm_finish_reason text, llm_charge_id uuid, assistant_reply text, llm_billing_snapshot jsonb,
  llm_billing_settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  delivery_attempt_id uuid);
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL REFERENCES experience.chat_generation_requests(chat_history_id),
  role text NOT NULL, provider text NOT NULL, provider_model_id text NOT NULL, generation_id text);
GRANT SELECT ON ALL TABLES IN SCHEMA experience TO service_role;

CREATE FUNCTION pg_temp.turn(p_tag text, p_age interval, p_status text, p_snapshot_provider text,
  p_delivery_provider text, p_generation text, p_settled boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_h uuid := md5('h' || p_tag)::uuid; v_a uuid := md5('a' || p_tag)::uuid;
BEGIN
  INSERT INTO experience.chat_history(id, user_id, model, status, llm_charge_id, llm_billing_snapshot,
    llm_billing_settled_at, created_at)
  VALUES (v_h, md5('user')::uuid, 'm', p_status, md5('c' || p_tag)::uuid,
    CASE WHEN p_snapshot_provider IS NOT NULL THEN jsonb_build_object('provider', p_snapshot_provider, 'charge_id', md5('c' || p_tag)::uuid) END,
    CASE WHEN p_settled THEN now() END, now() - p_age);
  INSERT INTO experience.chat_generation_requests(chat_history_id) VALUES (v_h);
  -- A losing primary attempt with its own generation is always present; it must never be returned.
  INSERT INTO experience.chat_generation_attempts VALUES (md5('l' || p_tag)::uuid, v_h, 'primary', 'surplus', 'm', 'loser-' || p_tag);
  IF p_delivery_provider IS NOT NULL THEN
    INSERT INTO experience.chat_generation_attempts VALUES (v_a, v_h, 'fallback', p_delivery_provider, 'm', p_generation);
    UPDATE experience.chat_generation_requests SET delivery_attempt_id = v_a WHERE chat_history_id = v_h;
  END IF;
END $$;
SELECT pg_temp.turn('or',            '20 minutes', 'success',            'openrouter', 'openrouter', 'g-or');
SELECT pg_temp.turn('or_settled',    '20 minutes', 'success',            'openrouter', 'openrouter', 'g-or2', true);
SELECT pg_temp.turn('or_streaming',  '20 minutes', 'streaming',          'openrouter', 'openrouter', 'g-or3');
SELECT pg_temp.turn('or_no_quote',   '20 minutes', 'success',            NULL,         'openrouter', 'g-or4');
SELECT pg_temp.turn('or_too_old',    '30 hours',   'success',            'openrouter', 'openrouter', 'g-or5');
SELECT pg_temp.turn('or_mismatch',   '19 minutes', 'success',            'venice',     'openrouter', 'g-or6');
SELECT pg_temp.turn('ve',            '18 minutes', 'success',            'venice',     'venice',     'g-ve');
SELECT pg_temp.turn('sp',            '17 minutes', 'success',            'surplus',    'surplus',    'g-sp');
SELECT pg_temp.turn('sp_undelivered','16 minutes', 'stream_interrupted', 'surplus',    NULL,         NULL);
SELECT pg_temp.turn('sp_streaming',  '15 minutes', 'streaming',          'surplus',    NULL,         NULL);
SELECT pg_temp.turn('sp_fallback',   '14 minutes', 'success',            'surplus',    'openrouter', 'g-fb');
SELECT pg_temp.turn('no_gen',        '13 minutes', 'success',            'openrouter', 'openrouter', NULL);
SELECT pg_temp.turn('fresh_missing', '30 seconds', 'stream_interrupted', 'openrouter', NULL,         NULL);
SELECT pg_temp.turn('stale_stream',  '12 minutes', 'streaming',          'venice',     NULL,         NULL);
-- 60 more delivered OpenRouter turns to check the 50-row budget and ordering.
SELECT pg_temp.turn('bulk' || lpad(i::text, 2, '0'), make_interval(mins => 200 - i), 'success', 'openrouter', 'openrouter', 'g-b' || i)
FROM generate_series(1, 60) i;
SQL

"${admin_psql[@]}" <"$migration" >/dev/null

# Run every scan as service_role and keep (tag, delivery provider, generation) per scan.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.results (scan text, pos int, tag text, delivery_provider text, generation_id text);
GRANT INSERT ON test_fixture.results TO service_role;
CREATE TABLE test_fixture.tags AS SELECT md5('h' || t)::uuid AS id, t AS tag FROM unnest(ARRAY['or','or_settled','or_streaming',
  'or_no_quote','or_too_old','or_mismatch','ve','sp','sp_undelivered','sp_streaming','sp_fallback','no_gen',
  'fresh_missing','stale_stream']) t
  UNION ALL SELECT md5('h' || 'bulk' || lpad(i::text, 2, '0'))::uuid, 'bulk' FROM generate_series(1, 60) i;
GRANT SELECT ON test_fixture.tags TO service_role;
SET ROLE service_role;
INSERT INTO test_fixture.results
SELECT s.scan, c.ord, t.tag, c.delivery_provider, c.generation_id
FROM unnest(ARRAY['openrouter','venice','surplus','missing_identity','bogus']) s(scan)
CROSS JOIN LATERAL experience.list_chat_settlement_candidates(s.scan, now() - interval '24 hours', 50,
  now() - interval '120 seconds') WITH ORDINALITY c(id, user_id, model, session_id, llm_finish_reason, llm_charge_id,
  assistant_reply, status, llm_billing_snapshot, llm_billing_settled_at, delivery_provider, generation_id, ord)
JOIN test_fixture.tags t ON t.id = c.id;
RESET ROLE;
SQL

check "openrouter scan: delivered OpenRouter turns only, oldest first, capped at 50, mismatch still listed" <<'SQL'
SELECT count(*) = 50 AND count(*) FILTER (WHERE tag = 'bulk') = 50
  AND bool_and(delivery_provider = 'openrouter' AND generation_id NOT LIKE 'loser-%')
  AND max(generation_id) FILTER (WHERE pos = 1) = 'g-b1' AND max(generation_id) FILTER (WHERE pos = 50) = 'g-b50'
FROM test_fixture.results WHERE scan = 'openrouter';
SQL
check "openrouter scan without the bulk budget pressure includes or / or_mismatch / sp_fallback and nothing excluded" <<'SQL'
SELECT array_agg(t.tag ORDER BY c.ord) = ARRAY['or','or_mismatch','sp_fallback']
FROM experience.list_chat_settlement_candidates('openrouter', now() - interval '25 minutes', 50, NULL)
  WITH ORDINALITY c(id, user_id, model, session_id, llm_finish_reason, llm_charge_id, assistant_reply, status,
    llm_billing_snapshot, llm_billing_settled_at, delivery_provider, generation_id, ord)
JOIN test_fixture.tags t ON t.id = c.id;
SQL
check "venice scan returns the delivered Venice turn" <<'SQL'
SELECT array_agg(tag || ':' || generation_id) = ARRAY['ve:g-ve'] FROM test_fixture.results WHERE scan = 'venice';
SQL
check "surplus scan: by frozen quote, delivered identity only (fallback winner shows its own provider)" <<'SQL'
SELECT array_agg(tag || ':' || coalesce(delivery_provider, '-') || ':' || coalesce(generation_id, '-') ORDER BY pos)
  = ARRAY['sp:surplus:g-sp', 'sp_undelivered:-:-', 'sp_fallback:openrouter:g-fb']
FROM test_fixture.results WHERE scan = 'surplus';
SQL
check "missing_identity: no delivered generation, past the grace period, streaming allowed, fresh excluded" <<'SQL'
SELECT array_agg(tag ORDER BY pos) = ARRAY['sp_undelivered','sp_streaming','no_gen','stale_stream']
FROM test_fixture.results WHERE scan = 'missing_identity';
SQL
check "unknown scan returns nothing; a losing call's generation is never returned" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM test_fixture.results WHERE scan = 'bogus')
  AND NOT EXISTS (SELECT 1 FROM test_fixture.results WHERE generation_id LIKE 'loser-%');
SQL
check "budget is clamped to 1..50" <<'SQL'
SELECT (SELECT count(*) FROM experience.list_chat_settlement_candidates('openrouter', now() - interval '24 hours', 0, NULL)) = 1
  AND (SELECT count(*) FROM experience.list_chat_settlement_candidates('openrouter', now() - interval '24 hours', 500, NULL)) = 50;
SQL
check "only service_role may execute" <<'SQL'
SELECT has_function_privilege('service_role', 'experience.list_chat_settlement_candidates(text,timestamptz,integer,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'experience.list_chat_settlement_candidates(text,timestamptz,integer,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'experience.list_chat_settlement_candidates(text,timestamptz,integer,timestamptz)', 'EXECUTE');
SQL
before=$("${admin_psql[@]}" -At -c "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'list_chat_settlement_candidates'")
"${admin_psql[@]}" <"$migration" >/dev/null
after=$("${admin_psql[@]}" -At -c "SELECT md5(prosrc) || ':' || count(*) OVER () FROM pg_proc WHERE proname = 'list_chat_settlement_candidates'")
[[ "$after" == "$before:1" ]] || { echo "FAIL: rerun changed the function ($before -> $after)"; exit 1; }
echo "ok: rerun keeps one identical function"
echo "PASS: p6a2b settlement candidates"
