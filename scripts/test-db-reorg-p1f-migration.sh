#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_drop_analytics_grafana.sql as a NON-superuser with CREATEROLE (like Supabase's
# postgres): idempotent re-run; analytics_grafana and the grafana_reader group role are dropped; grafana_cloud
# still reads miniapp_analytics; the guard refuses (and changes nothing) while an outside view depends on it.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_drop_analytics_grafana.sql"

run_case() {
  local with_outside_dependency="$1"
  local task_container="st-db-reorg-p1f-${RANDOM}-$$"
  docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
  # shellcheck disable=SC2064
  trap "docker rm -f $task_container >/dev/null 2>&1 || true" RETURN
  for _ in $(seq 1 30); do
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
CREATE ROLE grafana_reader NOLOGIN;
CREATE ROLE grafana_cloud NOLOGIN;
GRANT grafana_reader TO grafana_cloud;
CREATE SCHEMA app_core; CREATE SCHEMA miniapp_analytics; CREATE SCHEMA analytics_grafana;
CREATE TABLE app_core.users(id int PRIMARY KEY);
INSERT INTO app_core.users VALUES (1), (2);
CREATE VIEW miniapp_analytics.grafana_core_daily_v AS SELECT count(*) AS n FROM app_core.users;
CREATE VIEW analytics_grafana.v_wallet_daily WITH (security_barrier = true) AS SELECT id FROM app_core.users;
CREATE MATERIALIZED VIEW analytics_grafana.mv_business_daily AS SELECT count(*) AS n FROM app_core.users;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics_grafana GRANT SELECT ON TABLES TO grafana_reader;
GRANT USAGE ON SCHEMA analytics_grafana TO grafana_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics_grafana TO grafana_reader;
GRANT USAGE ON SCHEMA miniapp_analytics TO grafana_cloud;
GRANT SELECT ON miniapp_analytics.grafana_core_daily_v TO grafana_cloud;
SQL

  if [[ "$with_outside_dependency" == yes ]]; then
    "${admin_psql[@]}" >/dev/null <<'SQL'
CREATE VIEW miniapp_analytics.leans_on_grafana AS SELECT id FROM analytics_grafana.v_wallet_daily;
SQL
    if "${admin_psql[@]}" >/dev/null 2>&1 < "$migration"; then
      echo 'migration dropped a schema that an outside view still depends on' >&2
      exit 1
    fi
    "${admin_psql[@]}" -c "DO \$\$ BEGIN IF to_regnamespace('analytics_grafana') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='grafana_reader') THEN RAISE EXCEPTION 'guard failed but objects changed'; END IF; END \$\$;" >/dev/null
    echo "case outside_dependency=yes OK (refused, unchanged)"
    return
  fi

  "${admin_psql[@]}" >/dev/null < "$migration"
  # Re-running must be a no-op rather than an error.
  "${admin_psql[@]}" >/dev/null < "$migration"

  "${super_psql[@]}" <<'SQL'
\set QUIET on
DO $chk$
BEGIN
  IF to_regnamespace('analytics_grafana') IS NOT NULL THEN RAISE EXCEPTION 'analytics_grafana survived'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN RAISE EXCEPTION 'grafana_reader survived'; END IF;
  IF NOT has_table_privilege('grafana_cloud', 'miniapp_analytics.grafana_core_daily_v', 'SELECT') THEN
    RAISE EXCEPTION 'grafana_cloud lost miniapp_analytics';
  END IF;
END $chk$;
SET ROLE grafana_cloud;
SELECT n FROM miniapp_analytics.grafana_core_daily_v \gset
RESET ROLE;
SQL
  echo "case outside_dependency=no OK"
}

run_case no
run_case yes
echo 'OK: 20261117_db_reorg_drop_analytics_grafana.sql'
