#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p5b_prompt_retention.sql as a NON-superuser:
# - copies only frozen prompts (with billing snapshot) of the last 7 days, keeps created_at = turn time,
#   skips request markers, older turns and new turns without history, never overwrites rows already in ops;
#   the copied jsonb is byte-identical; the helper procedure is dropped; a rerun copies nothing;
# - an unfinished copy (deadline) raises "rerun this file" and the next run completes it;
# - the cleanup function deletes only rows older than the retention, in bounded batches, and rejects < 1 day;
# - with a pg_cron stand-in the hourly job is scheduled once; without pg_cron (TEST) the file still applies.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p5b_prompt_retention.sql"
task_container="st-db-reorg-p5b-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT anon, authenticated, service_role TO app_admin;
CREATE DATABASE with_cron OWNER app_admin;
CREATE DATABASE without_cron OWNER app_admin;
SQL
psql_in() { docker exec -i "$task_container" psql -X -q -U app_admin -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
check() { # db label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_in "$1" -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $2 (got: $got)"; exit 1; fi
  echo "ok: $2"
}
fixture() { # db with_cron(0/1)
  psql_in "$1" >/dev/null <<'SQL'
CREATE SCHEMA experience; CREATE SCHEMA ops;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, created_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'success',
  history jsonb, llm_billing_snapshot jsonb);
-- Production shape of the 5a table (20261119_db_reorg_p5_chat_history_expand.sql).
CREATE TABLE ops.chat_prompt_observations (
  history_id uuid NOT NULL, messages_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_prompt_observations_pkey PRIMARY KEY (history_id),
  CONSTRAINT chat_prompt_observations_messages_snapshot_check CHECK (jsonb_typeof(messages_snapshot) = 'array'));
CREATE INDEX chat_prompt_observations_created_at_idx ON ops.chat_prompt_observations (created_at);
-- prompt of n messages with a large system prompt (TOASTed like production)
CREATE FUNCTION pg_temp.prompt(seed int) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_array(
    jsonb_build_object('role','system','request_id',md5(seed::text)::uuid,'content',repeat(md5(seed::text), 400)),
    jsonb_build_object('role','user','content','hi ' || seed)) $f$;
-- a: 30 frozen prompts in window; b: 5 request markers in window; c: 4 frozen prompts older than 8 days;
-- d: 6 new turns (history NULL, already in ops); e: 3 old-history turns already in ops with a different value.
INSERT INTO experience.chat_history (id, created_at, history, llm_billing_snapshot)
SELECT ('00000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, now() - interval '6 days' + g * interval '1 minute',
       pg_temp.prompt(g), '{"billing_mode":"fixed_tier"}'
FROM generate_series(1, 30) g;
INSERT INTO experience.chat_history (id, created_at, history, llm_billing_snapshot)
SELECT ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, now() - interval '2 days',
       jsonb_build_array(jsonb_build_object('request_id', md5(g::text)::uuid)), NULL
FROM generate_series(1, 5) g;
INSERT INTO experience.chat_history (id, created_at, history, llm_billing_snapshot)
SELECT ('00000000-0000-0000-0002-' || lpad(g::text, 12, '0'))::uuid, now() - interval '8 days',
       pg_temp.prompt(100 + g), '{"billing_mode":"fixed_tier"}'
FROM generate_series(1, 4) g;
INSERT INTO experience.chat_history (id, created_at, history, llm_billing_snapshot)
SELECT ('00000000-0000-0000-0003-' || lpad(g::text, 12, '0'))::uuid, now() - interval '1 hour', NULL, '{"billing_mode":"fixed_tier"}'
FROM generate_series(1, 6) g;
INSERT INTO ops.chat_prompt_observations (history_id, messages_snapshot, created_at)
SELECT ('00000000-0000-0000-0003-' || lpad(g::text, 12, '0'))::uuid, pg_temp.prompt(200 + g), now() - interval '1 hour'
FROM generate_series(1, 6) g;
INSERT INTO experience.chat_history (id, created_at, history, llm_billing_snapshot)
SELECT ('00000000-0000-0000-0004-' || lpad(g::text, 12, '0'))::uuid, now() - interval '3 days', pg_temp.prompt(300 + g), '{"billing_mode":"fixed_tier"}'
FROM generate_series(1, 3) g;
INSERT INTO ops.chat_prompt_observations (history_id, messages_snapshot, created_at)
SELECT ('00000000-0000-0000-0004-' || lpad(g::text, 12, '0'))::uuid, '["kept"]', now() - interval '3 days'
FROM generate_series(1, 3) g;
SQL
  if [[ "$2" == 1 ]]; then
    psql_in "$1" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, jobname text);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS
  $f$ INSERT INTO cron.job (schedule, command, jobname) VALUES (schedule, command, job_name) RETURNING jobid $f$;
SQL
  fi
}

# 1. production shape
fixture with_cron 1
out=$(psql_in with_cron <"$migration" 2>&1)
[[ "$out" == *'copied 30 prompt snapshots this run, copied all'* ]] || { echo "FAIL: first apply output: $out"; exit 1; }
check with_cron 'copies only frozen prompts of the last 7 days, byte-identical, created_at = turn time' <<'SQL'
SELECT (SELECT count(*) FROM ops.chat_prompt_observations) = 30 + 6 + 3
  AND NOT EXISTS (
    SELECT 1 FROM experience.chat_history h
    WHERE h.id::text LIKE '00000000-0000-0000-0000-%'
      AND NOT EXISTS (SELECT 1 FROM ops.chat_prompt_observations o
                      WHERE o.history_id = h.id AND o.messages_snapshot::text = h.history::text AND o.created_at = h.created_at))
  AND NOT EXISTS (SELECT 1 FROM ops.chat_prompt_observations
                  WHERE history_id::text LIKE '00000000-0000-0000-0001-%' OR history_id::text LIKE '00000000-0000-0000-0002-%')
  AND (SELECT count(*) FROM ops.chat_prompt_observations WHERE messages_snapshot = '["kept"]') = 3
  AND to_regprocedure('ops.p5b_copy_prompt_history_step()') IS NULL;
SQL
check with_cron 'hourly retention job scheduled once; cleanup function not executable by API roles' <<'SQL'
SELECT (SELECT count(*) FROM cron.job WHERE jobname = 'chat_prompt_observations_retention' AND schedule = '17 * * * *'
          AND command LIKE '%ops.cleanup_chat_prompt_observations(interval ''7 days'', 1000, 20)%') = 1
  AND NOT has_function_privilege('service_role', 'ops.cleanup_chat_prompt_observations(interval,integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'ops.cleanup_chat_prompt_observations(interval,integer,integer)', 'EXECUTE');
SQL
out=$(psql_in with_cron <"$migration" 2>&1)
[[ "$out" == *'copied 0 prompt snapshots this run, copied all'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
check with_cron 'rerun copies nothing and does not schedule a second job' <<'SQL'
SELECT (SELECT count(*) FROM ops.chat_prompt_observations) = 39
  AND (SELECT count(*) FROM cron.job WHERE jobname = 'chat_prompt_observations_retention') = 1;
SQL

# 2. cleanup: only older than retention, bounded batches, refuses < 1 day.
psql_in with_cron >/dev/null <<'SQL'
UPDATE ops.chat_prompt_observations SET created_at = now() - interval '10 days'
WHERE history_id::text LIKE '00000000-0000-0000-0000-%';
SQL
got=$(psql_in with_cron -At <<'SQL'
SELECT ops.cleanup_chat_prompt_observations(interval '7 days', 7, 2);
SELECT ops.cleanup_chat_prompt_observations(interval '7 days', 1000, 20);
SELECT ops.cleanup_chat_prompt_observations(interval '7 days', 1000, 20);
SELECT count(*) FROM ops.chat_prompt_observations;
SQL
)
[[ "$(echo $got)" == '14 16 0 9' ]] || { echo "FAIL: cleanup batches (got: $(echo $got))"; exit 1; }
echo 'ok: cleanup honours batch bound then removes the rest, keeps rows inside retention'
if psql_in with_cron -c "SELECT ops.cleanup_chat_prompt_observations(interval '1 hour')" >/dev/null 2>&1; then
  echo 'FAIL: retention below 1 day accepted'; exit 1
fi
echo 'ok: retention below 1 day rejected'

# 3. unfinished copy raises and the next run completes (deadline forced to 0 seconds).
psql_in with_cron >/dev/null <<'SQL'
DELETE FROM ops.chat_prompt_observations WHERE history_id::text LIKE '00000000-0000-0000-0000-%';
SQL
short_migration="$(sed "s/interval '50 seconds'/interval '0 seconds'/" "$migration")"
if out=$(psql_in with_cron <<<"$short_migration" 2>&1); then echo "FAIL: unfinished copy did not raise: $out"; exit 1; fi
[[ "$out" == *'30 turns still to copy; rerun this file'* ]] || { echo "FAIL: unfinished copy message: $out"; exit 1; }
echo 'ok: unfinished copy asks for a rerun'
out=$(psql_in with_cron <"$migration" 2>&1)
[[ "$out" == *'copied 30 prompt snapshots this run, copied all'* ]] || { echo "FAIL: completing run output: $out"; exit 1; }
echo 'ok: next run completes the copy'

# 4. TEST shape: no pg_cron.
fixture without_cron 0
out=$(psql_in without_cron <"$migration" 2>&1)
[[ "$out" == *'copied 30 prompt snapshots this run, copied all'* ]] || { echo "FAIL: no-cron apply output: $out"; exit 1; }
check without_cron 'without pg_cron the copy and function still apply' <<'SQL'
SELECT (SELECT count(*) FROM ops.chat_prompt_observations) = 39
  AND to_regprocedure('ops.cleanup_chat_prompt_observations(interval,integer,integer)') IS NOT NULL;
SQL
echo 'all checks passed'
