#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_drop_drama_playback_sql.sql as a NON-superuser with CREATEROLE (like Supabase's
# postgres): idempotent re-run; table, view, functions, cron job and the drama_metrics_reader group role are gone;
# grafana_cloud still reads other miniapp_analytics views; a recent write or an outside dependent view makes the
# migration refuse without changing anything.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_drop_drama_playback_sql.sql"

run_case() {
  local variant="$1"
  local task_container="st-db-reorg-p2b-drama-${RANDOM}-$$"
  docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
  # shellcheck disable=SC2064
  trap "docker rm -f $task_container >/dev/null 2>&1 || true" RETURN
  for _ in $(seq 1 60); do
    if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
      docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  local super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
  local admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

  "${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL
  "${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE service_role NOLOGIN;
CREATE ROLE drama_metrics_reader NOLOGIN;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE ROLE grafana_cloud NOLOGIN;
GRANT drama_metrics_reader, first_token_metrics_reader TO grafana_cloud;
CREATE SCHEMA miniapp_analytics;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid = $1 RETURNING true $$;
INSERT INTO cron.job(jobname, schedule, command, active) VALUES
  ('drama_metrics_cleanup_daily', '15 19 * * *', 'SELECT miniapp_analytics.cleanup_drama_playback_observations(10000);', false),
  ('unrelated_job', '* * * * *', 'SELECT 1', true);

CREATE TABLE miniapp_analytics.drama_playback_observations (
  environment text NOT NULL, observation_id text NOT NULL, first_seen_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL, summary jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT drama_playback_observations_pk PRIMARY KEY (environment, observation_id)
);
ALTER TABLE miniapp_analytics.drama_playback_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY drama_metrics_read ON miniapp_analytics.drama_playback_observations FOR SELECT TO drama_metrics_reader USING (true);
GRANT SELECT (environment, observation_id, first_seen_at, last_received_at) ON miniapp_analytics.drama_playback_observations TO drama_metrics_reader;
GRANT SELECT, INSERT, UPDATE ON miniapp_analytics.drama_playback_observations TO service_role;
CREATE VIEW miniapp_analytics.drama_playback_facts AS
  SELECT environment, observation_id, first_seen_at FROM miniapp_analytics.drama_playback_observations;
GRANT USAGE ON SCHEMA miniapp_analytics TO drama_metrics_reader, first_token_metrics_reader;
GRANT SELECT ON miniapp_analytics.drama_playback_facts TO drama_metrics_reader;
CREATE FUNCTION miniapp_analytics.record_drama_playback_observation(text, jsonb, text, timestamptz, text)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE FUNCTION miniapp_analytics.cleanup_drama_playback_observations(integer)
  RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM miniapp_analytics.drama_playback_observations $$;
CREATE VIEW miniapp_analytics.grafana_core_daily_v AS SELECT 1 AS n;
GRANT SELECT ON miniapp_analytics.grafana_core_daily_v TO first_token_metrics_reader;
INSERT INTO miniapp_analytics.drama_playback_observations VALUES
  ('production', 'obs-1', '2026-10-28 10:00+08', '2026-10-29 16:34+08', '{}');
SQL

  if [[ "$variant" != normal ]]; then
    if [[ "$variant" == recent_write ]]; then
      "${admin_psql[@]}" -c "INSERT INTO miniapp_analytics.drama_playback_observations VALUES ('production', 'obs-2', now(), now(), '{}')" >/dev/null
    else
      "${admin_psql[@]}" -c "CREATE VIEW miniapp_analytics.leans_on_drama AS SELECT observation_id FROM miniapp_analytics.drama_playback_facts" >/dev/null
    fi
    if "${admin_psql[@]}" >/dev/null 2>&1 < "$migration"; then
      echo "migration ran despite $variant" >&2
      exit 1
    fi
    "${admin_psql[@]}" -c "DO \$\$ BEGIN IF to_regclass('miniapp_analytics.drama_playback_observations') IS NULL OR to_regclass('miniapp_analytics.drama_playback_facts') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drama_metrics_reader') OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drama_metrics_cleanup_daily') THEN RAISE EXCEPTION 'guard failed but objects changed'; END IF; END \$\$;" >/dev/null
    echo "case $variant OK (refused, unchanged)"
    return
  fi

  "${admin_psql[@]}" >/dev/null < "$migration"
  "${admin_psql[@]}" >/dev/null < "$migration"
  "${super_psql[@]}" <<'SQL'
\set QUIET on
DO $chk$
BEGIN
  IF to_regclass('miniapp_analytics.drama_playback_observations') IS NOT NULL
     OR to_regclass('miniapp_analytics.drama_playback_facts') IS NOT NULL
     OR to_regprocedure('miniapp_analytics.record_drama_playback_observation(text,jsonb,text,timestamptz,text)') IS NOT NULL
     OR to_regprocedure('miniapp_analytics.cleanup_drama_playback_observations(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'drama objects survived';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drama_metrics_reader') THEN RAISE EXCEPTION 'drama_metrics_reader survived'; END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drama_metrics_cleanup_daily')
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'unrelated_job') THEN
    RAISE EXCEPTION 'cron cleanup wrong';
  END IF;
  IF NOT has_table_privilege('grafana_cloud', 'miniapp_analytics.grafana_core_daily_v', 'SELECT') THEN
    RAISE EXCEPTION 'grafana_cloud lost other analytics views';
  END IF;
END $chk$;
SET ROLE grafana_cloud;
SELECT n FROM miniapp_analytics.grafana_core_daily_v \gset
RESET ROLE;
SQL
  echo "case normal OK"
}

run_case normal
run_case recent_write
run_case outside_view
echo 'OK: 20261117_db_reorg_drop_drama_playback_sql.sql'
