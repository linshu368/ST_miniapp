#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_drop_card_position_snapshot.sql as a NON-superuser:
# - with a pg_cron stand-in: the snapshot job is unscheduled, other jobs are kept, the table is dropped;
# - a rerun only prints "already dropped";
# - it refuses (and changes nothing) when another cron job writes the table or a view reads it;
# - without pg_cron (TEST) it only drops the table.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_drop_card_position_snapshot.sql"
task_container="st-db-reorg-snapshot-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
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
  psql_in "$1" >/dev/null <<SQL
CREATE SCHEMA miniapp_analytics;
CREATE TABLE miniapp_analytics.card_position_snapshot (
  snapshot_at timestamptz NOT NULL DEFAULT now(), character_id uuid, name text, sort_order integer, enabled boolean);
INSERT INTO miniapp_analytics.card_position_snapshot (character_id, name, sort_order, enabled)
SELECT gen_random_uuid(), 'c' || g, g, true FROM generate_series(1, 5) g;
SQL
  if [[ "$2" == 1 ]]; then
    psql_in "$1" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, jobname text);
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql AS
  $f$ DELETE FROM cron.job WHERE jobid = job_id RETURNING true $f$;
INSERT INTO cron.job (schedule, command, jobname) VALUES
  ('*/30 * * * *', 'SELECT 1', 'grafana_core_recent_30m'),
  ('0 * * * *', 'INSERT INTO miniapp_analytics.card_position_snapshot (character_id, name, sort_order, enabled) SELECT 1', 'card_position_hourly_snapshot');
SQL
  fi
}

# 1. production shape: job unscheduled, other job kept, table dropped; rerun is a no-op.
fixture with_cron 1
out=$(psql_in with_cron <"$migration" 2>&1)
[[ "$out" == *'cron jobs removed 1, table dropped'* ]] || { echo "FAIL: first apply output: $out"; exit 1; }
check with_cron 'snapshot job unscheduled, other job kept, table dropped' <<'SQL'
SELECT to_regclass('miniapp_analytics.card_position_snapshot') IS NULL
  AND (SELECT array_agg(jobname) FROM cron.job) = ARRAY['grafana_core_recent_30m'];
SQL
out=$(psql_in with_cron <"$migration" 2>&1)
[[ "$out" == *'already dropped'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun prints already dropped'

# 2. refusals leave everything intact.
psql_in with_cron >/dev/null <<'SQL'
DROP SCHEMA cron CASCADE; DROP SCHEMA miniapp_analytics CASCADE;
SQL
fixture with_cron 1
psql_in with_cron >/dev/null <<'SQL'
INSERT INTO cron.job (schedule, command, jobname)
VALUES ('5 * * * *', 'DELETE FROM miniapp_analytics.card_position_snapshot', 'other_writer');
SQL
if psql_in with_cron <"$migration" >/dev/null 2>&1; then echo 'FAIL: other cron writer not refused'; exit 1; fi
check with_cron 'refused when another cron job writes the table (nothing changed)' <<'SQL'
SELECT to_regclass('miniapp_analytics.card_position_snapshot') IS NOT NULL
  AND (SELECT count(*) FROM cron.job) = 3
  AND (SELECT count(*) FROM miniapp_analytics.card_position_snapshot) = 5;
SQL
psql_in with_cron >/dev/null <<'SQL'
DELETE FROM cron.job WHERE jobname = 'other_writer';
CREATE VIEW miniapp_analytics.snapshot_reader AS SELECT name FROM miniapp_analytics.card_position_snapshot;
SQL
if psql_in with_cron <"$migration" >/dev/null 2>&1; then echo 'FAIL: dependent view not refused'; exit 1; fi
check with_cron 'refused when a view reads the table (job kept)' <<'SQL'
SELECT to_regclass('miniapp_analytics.card_position_snapshot') IS NOT NULL
  AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'card_position_hourly_snapshot');
SQL

# 3. TEST shape: no pg_cron, only the table goes.
fixture without_cron 0
out=$(psql_in without_cron <"$migration" 2>&1)
[[ "$out" == *'cron jobs removed 0, table dropped'* ]] || { echo "FAIL: no-cron apply output: $out"; exit 1; }
check without_cron 'without pg_cron the table is dropped' <<'SQL'
SELECT to_regclass('miniapp_analytics.card_position_snapshot') IS NULL;
SQL
echo 'all checks passed'
