#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c3_discarded_contract.sql as a NON-superuser:
# - the observe fixture is the production body (md5 3a7ef089e58b04174321c40e984235bd); afterwards md5 00305dbb…;
# - race-lost fragments land in ops.llm_calls.discarded_detail (attempt row; created when missing), sanitised exactly
#   as before (allowlist, 2048-char cap, truncated flag); the attempt still ends as cancelled; invalid snapshots are
#   rejected; a recorded fragment is terminal (replays change nothing); ordinary observations still update attempts;
# - fragments written to the old column after the expand copy are carried over; the column is dropped;
# - a rerun is a no-op; a drifted observe function is refused and the column kept.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2c3_discarded_contract.sql"
task_container="st-db-reorg-p6a2c3d-${RANDOM}-$$"
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
observe() { psql_f -c "SELECT experience.observe_chat_generation_attempt('$1'::uuid, '$2'::jsonb)" >/dev/null; }
fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, ops CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA ops;
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL, role text NOT NULL, provider text NOT NULL,
  provider_model_id text NOT NULL, generation_id text, dispatched_at timestamptz, dispatch_offset_ms numeric,
  first_token_ms numeric, observed_until_ms numeric, end_reason text, finish_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(), discarded_response jsonb);
-- ops.llm_calls after the 6a-2c-3 expand (only what observe touches, plus the Surplus rule)
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY, attempt_id uuid UNIQUE, chat_history_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'venice', 'surplus')), model text, generation_id text,
  discarded_detail jsonb, lane text NOT NULL DEFAULT 'chat', cost_usd numeric, cost_source text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_calls_attempt_is_id CHECK (attempt_id IS NULL OR attempt_id = id));
CREATE UNIQUE INDEX llm_calls_surplus_attempt_turn_idx ON ops.llm_calls (chat_history_id)
  WHERE provider = 'surplus' AND attempt_id IS NOT NULL;
INSERT INTO experience.chat_generation_attempts (id, chat_history_id, role, provider, provider_model_id) VALUES
  ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0000-000000000001', 'primary', 'surplus', 's/m'),
  ('00000000-0000-0000-0001-000000000002', '00000000-0000-0000-0000-000000000001', 'fallback', 'openrouter', 'or/fb'),
  ('00000000-0000-0000-0001-000000000003', '00000000-0000-0000-0000-000000000002', 'primary', 'openrouter', 'or/m'),
  ('00000000-0000-0000-0001-000000000004', '00000000-0000-0000-0000-000000000003', 'primary', 'venice', 'v/m');
-- the Surplus primary already has its call row (prepare); the others do not
INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, model, cost_usd, cost_source)
VALUES ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0001-000000000001',
        '00000000-0000-0000-0000-000000000001', 'surplus', 's/m', 0.0004, 'surplus_buyer');
SQL
  psql_f >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION experience.observe_chat_generation_attempt(p_history_id uuid, p_observation jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $prodfn$
DECLARE a experience.chat_generation_attempts%ROWTYPE; v_discarded jsonb; v_input jsonb;
BEGIN
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=(p_observation->>'id')::uuid AND chat_history_id=p_history_id FOR UPDATE;
  IF a.provider IS DISTINCT FROM p_observation->>'provider' OR a.provider_model_id IS DISTINCT FROM p_observation->>'model' OR a.role IS DISTINCT FROM p_observation->>'role' THEN
    RAISE EXCEPTION 'Attempt route cannot be rebound' USING ERRCODE='22023';
  END IF;
  IF a.generation_id IS NOT NULL AND p_observation->>'generation_id' IS NOT NULL AND a.generation_id <> p_observation->>'generation_id' THEN
    RAISE EXCEPTION 'Attempt generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- A stopped loser is terminal. Replayed/later snapshots cannot overwrite or
  -- enlarge its diagnostic payload, and duplicate reports cause no UPDATE.
  IF a.discarded_response IS NOT NULL THEN RETURN; END IF;
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
    discarded_response=v_discarded,
    finish_reason=COALESCE(finish_reason,left(p_observation->>'finish_reason',128)),updated_at=clock_timestamp()
  WHERE id=a.id;
END;
$prodfn$;
SQL
}

fixture
check 'fixture observe is the production body' <<'SQL'
SELECT md5(prosrc) = '3a7ef089e58b04174321c40e984235bd' FROM pg_proc WHERE proname = 'observe_chat_generation_attempt';
SQL
# A fragment recorded by the old function after the expand copy (must be carried over).
observe 00000000-0000-0000-0000-000000000003 '{"id":"00000000-0000-0000-0001-000000000004","provider":"venice","model":"v/m","role":"primary","discarded_response":{"reason":"race_lost","content":"late","reasoning":"","truncated":false}}'
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'writes fragments to ops.llm_calls'* && "$out" == *'1 late fragments copied, attempts.discarded_response dropped'* ]] ||
  { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: apply patched observe, carried 1 late fragment and dropped the column'
check 'observe md5 and dropped column; late fragment carried over' <<'SQL'
SELECT md5(prosrc) = '00305dbb27cbdfdcc0f554b48b1156a8' FROM pg_proc WHERE proname = 'observe_chat_generation_attempt';
SQL
check 'late fragment is in ops' <<'SQL'
SELECT (SELECT discarded_detail->>'content' FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000004') = 'late'
  AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_generation_attempts'::regclass
                  AND attname = 'discarded_response' AND NOT attisdropped);
SQL

long=$(printf 'x%.0s' $(seq 1 2100))
# Race loser with an existing call row (Surplus primary): fragment sanitised and capped, attempt cancelled.
observe 00000000-0000-0000-0000-000000000001 "{\"id\":\"00000000-0000-0000-0001-000000000001\",\"provider\":\"surplus\",\"model\":\"s/m\",\"role\":\"primary\",\"generation_id\":\"gen-1\",\"end_reason\":\"first_token_observed\",\"discarded_response\":{\"reason\":\"race_lost\",\"content\":\"$long\",\"reasoning\":\"r\",\"truncated\":false,\"extra\":\"dropped\"}}"
check 'fragment written to the existing call row: allowlist, cap, truncated flag; cost untouched; attempt cancelled' <<'SQL'
SELECT (SELECT length(discarded_detail->>'content') FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000001') = 2048
  AND (SELECT (discarded_detail->>'truncated')::boolean AND NOT discarded_detail ? 'extra' AND cost_source = 'surplus_buyer'
       FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000001')
  AND (SELECT row(end_reason, generation_id)::text FROM experience.chat_generation_attempts WHERE id = '00000000-0000-0000-0001-000000000001')
      = '(cancelled,gen-1)';
SQL
# Replay with another fragment and later fields: terminal, nothing changes.
observe 00000000-0000-0000-0000-000000000001 '{"id":"00000000-0000-0000-0001-000000000001","provider":"surplus","model":"s/m","role":"primary","finish_reason":"stop","discarded_response":{"reason":"race_lost","content":"other","reasoning":"","truncated":false}}'
check 'a recorded fragment is terminal' <<'SQL'
SELECT (SELECT length(discarded_detail->>'content') FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000001') = 2048
  AND (SELECT finish_reason IS NULL FROM experience.chat_generation_attempts WHERE id = '00000000-0000-0000-0001-000000000001');
SQL
# Race loser without a call row (OpenRouter fallback): the row is created.
observe 00000000-0000-0000-0000-000000000001 '{"id":"00000000-0000-0000-0001-000000000002","provider":"openrouter","model":"or/fb","role":"fallback","generation_id":"gen-fb","discarded_response":{"reason":"race_lost","content":"fb","reasoning":"","truncated":false}}'
check 'fragment creates the call row when missing' <<'SQL'
SELECT (SELECT row(attempt_id = id, provider, model, generation_id, discarded_detail->>'content')::text
        FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000002') = '(t,openrouter,or/fb,gen-fb,fb)';
SQL
# Invalid snapshot is rejected; ordinary observation still updates the attempt.
if psql_f -c "SELECT experience.observe_chat_generation_attempt('00000000-0000-0000-0000-000000000002', '{\"id\":\"00000000-0000-0000-0001-000000000003\",\"provider\":\"openrouter\",\"model\":\"or/m\",\"role\":\"primary\",\"discarded_response\":{\"reason\":\"other\"}}')" >/dev/null 2>&1; then
  echo 'FAIL: invalid snapshot accepted'; exit 1
fi
echo 'ok: invalid snapshot rejected'
observe 00000000-0000-0000-0000-000000000002 '{"id":"00000000-0000-0000-0001-000000000003","provider":"openrouter","model":"or/m","role":"primary","generation_id":"gen-3","end_reason":"first_token_observed","finish_reason":"stop","observed_until_ms":120}'
check 'ordinary observation updates the attempt and creates no call row' <<'SQL'
SELECT (SELECT row(generation_id, end_reason, finish_reason, observed_until_ms)::text FROM experience.chat_generation_attempts
        WHERE id = '00000000-0000-0000-0001-000000000003') = '(gen-3,first_token_observed,stop,120)'
  AND NOT EXISTS (SELECT 1 FROM ops.llm_calls WHERE id = '00000000-0000-0000-0001-000000000003');
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'already writes ops.llm_calls'* && "$out" == *'already dropped'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun is a no-op'

# Drifted observe is refused and the column kept.
fixture
psql_f >/dev/null <<'SQL'
DO $d$ BEGIN
  EXECUTE replace(pg_get_functiondef('experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure),
                  'Attempt route cannot be rebound', 'Attempt route cannot be rebound!');
END $d$;
SQL
if out=$(psql_f <"$migration" 2>&1); then echo 'FAIL: drifted observe not refused'; exit 1; fi
[[ "$out" == *'observe_chat_generation_attempt drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'refusal kept the column' <<'SQL'
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_generation_attempts'::regclass
               AND attname = 'discarded_response' AND NOT attisdropped);
SQL
echo 'all checks passed'
