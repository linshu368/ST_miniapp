#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_cleanup.sql: idempotent re-run; PostgREST exposure GUCs lose only
# miniapp / cs_platform and keep their order; the botlinks-backed view keeps its output; dropped
# objects are gone; st_initialized_at survives; environments without the GUC or pg_cron are skipped.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_cleanup.sql"

run_case() {
  local with_guc="$1"
  local task_container="st-db-reorg-p1d-${RANDOM}-$$"
  docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
  # shellcheck disable=SC2064
  trap "docker rm -f $task_container >/dev/null 2>&1 || true" RETURN
  for _ in $(seq 1 30); do
    if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
      docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  local task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

  "${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA app_core;
CREATE SCHEMA miniapp_traffic;
CREATE SCHEMA miniapp_features;
CREATE SCHEMA miniapp;
CREATE SCHEMA cs_platform;
CREATE TABLE app_core.users(id uuid PRIMARY KEY, tg_id text NOT NULL, st_handle text, st_initialized_at timestamptz,
  CONSTRAINT users_st_handle_key UNIQUE (st_handle));
CREATE TABLE miniapp_traffic.botlinks(id bigint PRIMARY KEY, source_id text, "Purchase_amount" integer, "Procurement_days" integer);
CREATE VIEW miniapp_traffic.traffic_daily_stats AS
  SELECT b.source_id, b."Purchase_amount" AS purchase_amount, b."Procurement_days" AS procurement_days,
         CASE WHEN COALESCE(b."Procurement_days", 0) > 0 THEN round(b."Purchase_amount"::numeric / b."Procurement_days", 2) END AS daily_cost
  FROM miniapp_traffic.botlinks b;
CREATE TABLE miniapp_features.wish_roles(id uuid PRIMARY KEY, db_user_id uuid);
CREATE FUNCTION miniapp_features.create_wish_role(p_db_user_id uuid, p_telegram_user_id bigint, p_wish_text text, p_reward_credits integer)
  RETURNS void LANGUAGE sql AS $$ SELECT 1 FROM miniapp_features.wish_roles LIMIT 0 $$;
CREATE FUNCTION miniapp_features.complete_wish_role(p_db_user_id uuid, p_telegram_user_id bigint, p_wish_id uuid, p_extra_text text)
  RETURNS void LANGUAGE sql AS $$ SELECT 1 FROM miniapp_features.wish_roles LIMIT 0 $$;
CREATE TABLE cs_platform.support_conversations(id uuid PRIMARY KEY, user_id uuid REFERENCES app_core.users(id));
CREATE VIEW cs_platform.user_metrics AS SELECT id FROM app_core.users;
CREATE FUNCTION cs_platform.noop() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.compute_daily_metrics(p_from date, p_to date) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION public.show_dashboard() RETURNS void LANGUAGE sql AS $$ SELECT $$;
INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000001','1','h1',now());
INSERT INTO miniapp_traffic.botlinks VALUES (1,'s1',700,7),(2,'s2',100,0);
CREATE TABLE before_view AS SELECT * FROM miniapp_traffic.traffic_daily_stats;
SQL
  if [[ "$with_guc" == yes ]]; then
    "${task_psql[@]}" >/dev/null <<'SQL'
ALTER ROLE authenticator SET pgrst.db_schemas = 'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing, drama_archive, media_plaza';
ALTER ROLE authenticator SET pgrst.db_extra_search_path = 'public, graphql_public, miniapp, miniapp_traffic';
SQL
  fi

  "${task_psql[@]}" >/dev/null < "$migration"
  # Re-running must be a no-op rather than an error.
  "${task_psql[@]}" >/dev/null < "$migration"

  "${task_psql[@]}" -v with_guc="$with_guc" <<'SQL'
\set QUIET on
SELECT :'with_guc' = 'yes' AS with_guc \gset
DO $chk$
DECLARE v_schemas text; v_path text;
BEGIN
  SELECT split_part(c, '=', 2) INTO v_schemas FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole,
    unnest(s.setconfig) c WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';
  SELECT split_part(c, '=', 2) INTO v_path FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole,
    unnest(s.setconfig) c WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_extra_search_path=%';
  IF v_schemas IS NOT NULL AND v_schemas <> 'graphql_public, miniapp_analytics, miniapp_traffic, admin, app_core, miniapp_features, experience, billing, drama_archive, media_plaza' THEN
    RAISE EXCEPTION 'db_schemas wrong: %', v_schemas;
  END IF;
  IF v_path IS NOT NULL AND v_path <> 'public, graphql_public, miniapp_traffic' THEN
    RAISE EXCEPTION 'extra_search_path wrong: %', v_path;
  END IF;
  IF to_regnamespace('cs_platform') IS NOT NULL OR to_regnamespace('miniapp') IS NOT NULL THEN RAISE EXCEPTION 'schema not dropped'; END IF;
  IF to_regclass('miniapp_features.wish_roles') IS NOT NULL THEN RAISE EXCEPTION 'wish_roles not dropped'; END IF;
  IF to_regprocedure('public.show_dashboard()') IS NOT NULL OR to_regprocedure('public.compute_daily_metrics(date,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'public functions not dropped';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app_core' AND table_name='users' AND column_name='st_handle') THEN
    RAISE EXCEPTION 'st_handle not dropped';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app_core' AND table_name='users' AND column_name='st_initialized_at') THEN
    RAISE EXCEPTION 'st_initialized_at must survive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='miniapp_traffic' AND table_name='botlinks' AND column_name='purchase_amount') THEN
    RAISE EXCEPTION 'botlinks not renamed';
  END IF;
  IF EXISTS (SELECT * FROM before_view EXCEPT SELECT * FROM miniapp_traffic.traffic_daily_stats)
     OR EXISTS (SELECT * FROM miniapp_traffic.traffic_daily_stats EXCEPT SELECT * FROM before_view) THEN
    RAISE EXCEPTION 'traffic_daily_stats output changed';
  END IF;
END $chk$;
SELECT (SELECT count(*) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='authenticator') AS guc_rows \gset
\if :with_guc
\else
SELECT :guc_rows = 0 AS no_guc_ok \gset
\if :no_guc_ok
\else
\echo 'GUC appeared in no-GUC environment'
\quit 3
\endif
\endif
SQL
  echo "case with_guc=$with_guc OK"
}

run_case yes
run_case no
echo 'OK: 20261117_db_reorg_cleanup.sql'
