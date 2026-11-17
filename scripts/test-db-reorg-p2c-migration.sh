#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_revoke_reader_and_browser_grants.sql as a NON-superuser with CREATEROLE (like Supabase's
# postgres): idempotent re-run; the metrics reader and grafana_cloud still read the first-token view and report with
# unchanged row counts but are refused on experience tables; anon/authenticated keep no table privilege in business
# schemas while admin grants stay; RLS on chat_history/botlinks/traffic_clicks leaves service_role reads/writes intact.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_revoke_reader_and_browser_grants.sql"
task_container="st-db-reorg-p2c-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture mirrors the production ACL/RLS shape collected on 2026-11-17.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN NOINHERIT;
CREATE ROLE grafana_cloud NOLOGIN;
GRANT first_token_metrics_reader TO grafana_cloud;
GRANT service_role, first_token_metrics_reader, grafana_cloud, anon, authenticated TO app_admin;
CREATE SCHEMA experience; CREATE SCHEMA miniapp_analytics; CREATE SCHEMA miniapp_traffic;
CREATE SCHEMA billing; CREATE SCHEMA admin;
GRANT USAGE ON SCHEMA experience, miniapp_analytics, miniapp_traffic, billing, admin TO service_role;
GRANT USAGE ON SCHEMA experience, miniapp_analytics TO first_token_metrics_reader;
GRANT USAGE ON SCHEMA admin TO authenticated;

CREATE TABLE experience.chat_history (id uuid PRIMARY KEY, status text, llm_finish_reason text, assistant_reply text);
CREATE TABLE experience.chat_generation_requests (chat_history_id uuid PRIMARY KEY, client_outcome text, request_received_at timestamptz);
CREATE TABLE experience.chat_generation_attempts (id uuid PRIMARY KEY, chat_history_id uuid, role text, first_token_ms numeric);
ALTER TABLE experience.chat_generation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.chat_generation_attempts ENABLE ROW LEVEL SECURITY;
CREATE TABLE miniapp_traffic.botlinks (id int PRIMARY KEY, name text);
CREATE TABLE miniapp_traffic.traffic_clicks (id int PRIMARY KEY, botlink_id int);
CREATE VIEW miniapp_traffic.traffic_daily_stats AS SELECT botlink_id, count(*) AS n FROM miniapp_traffic.traffic_clicks GROUP BY 1;
CREATE TABLE billing.user_wallets (user_id uuid PRIMARY KEY, credits int);
ALTER TABLE billing.user_wallets ENABLE ROW LEVEL SECURITY;
CREATE TABLE admin.admin_users (id uuid PRIMARY KEY);
ALTER TABLE admin.admin_users ENABLE ROW LEVEL SECURITY;

GRANT ALL ON experience.chat_history, experience.chat_generation_requests, experience.chat_generation_attempts,
  miniapp_traffic.botlinks, miniapp_traffic.traffic_clicks, miniapp_traffic.traffic_daily_stats, billing.user_wallets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON experience.chat_history, miniapp_traffic.botlinks, miniapp_traffic.traffic_clicks,
  miniapp_traffic.traffic_daily_stats, billing.user_wallets TO anon, authenticated;
GRANT SELECT ON admin.admin_users TO authenticated;
GRANT SELECT ON experience.chat_generation_requests, experience.chat_generation_attempts TO first_token_metrics_reader;
GRANT SELECT (id, status, llm_finish_reason) ON experience.chat_history TO first_token_metrics_reader;
CREATE POLICY first_token_metrics_read ON experience.chat_generation_requests FOR SELECT TO first_token_metrics_reader USING (true);
CREATE POLICY first_token_metrics_read ON experience.chat_generation_attempts FOR SELECT TO first_token_metrics_reader USING (true);
CREATE POLICY first_token_metrics_read ON experience.chat_history FOR SELECT TO first_token_metrics_reader USING (true);

CREATE VIEW miniapp_analytics.chat_first_token_facts WITH (security_invoker = true) AS
  SELECT r.chat_history_id, r.client_outcome, r.request_received_at, h.status, a.first_token_ms
  FROM experience.chat_generation_requests r
  JOIN experience.chat_history h ON h.id = r.chat_history_id
  LEFT JOIN experience.chat_generation_attempts a ON a.chat_history_id = r.chat_history_id AND a.role = 'primary';
GRANT SELECT ON miniapp_analytics.chat_first_token_facts TO service_role, first_token_metrics_reader;
CREATE FUNCTION miniapp_analytics.chat_first_token_report(p_from timestamptz, p_to timestamptz)
  RETURNS TABLE(n bigint) LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT count(*) FROM miniapp_analytics.chat_first_token_facts WHERE request_received_at >= p_from AND request_received_at < p_to
$$;
REVOKE ALL ON FUNCTION miniapp_analytics.chat_first_token_report(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION miniapp_analytics.chat_first_token_report(timestamptz, timestamptz) TO service_role, first_token_metrics_reader;

INSERT INTO experience.chat_history SELECT gen_random_uuid(), 'success', 'stop', 'hidden reply' FROM generate_series(1, 5);
INSERT INTO experience.chat_generation_requests SELECT id, 'observed', now() FROM experience.chat_history;
INSERT INTO experience.chat_generation_attempts SELECT gen_random_uuid(), id, 'primary', 800 FROM experience.chat_history;
INSERT INTO miniapp_traffic.botlinks VALUES (1, 'a');
INSERT INTO miniapp_traffic.traffic_clicks VALUES (1, 1), (2, 1);
SQL

before="$("${admin_psql[@]}" -At -c "SET ROLE first_token_metrics_reader; SELECT count(*) FROM miniapp_analytics.chat_first_token_facts")"
"${admin_psql[@]}" >/dev/null < "$migration"
"${admin_psql[@]}" >/dev/null < "$migration"

"${admin_psql[@]}" -v before="$before" <<'SQL'
\set QUIET on
SET ROLE first_token_metrics_reader;
SELECT count(*) AS n FROM miniapp_analytics.chat_first_token_facts \gset reader_
SELECT n AS n FROM miniapp_analytics.chat_first_token_report(now() - interval '1 day', now() + interval '1 day') \gset report_
RESET ROLE;
SET ROLE grafana_cloud;
SELECT count(*) AS n FROM miniapp_analytics.chat_first_token_facts \gset cloud_
RESET ROLE;
SELECT (:reader_n = :before AND :report_n = :before AND :cloud_n = :before) AS same_rows \gset
\if :same_rows
\else
  \echo 'first-token view/report row counts changed for readers'
  SELECT 1 / 0;
\endif

DO $chk$
DECLARE
  v_left text;
BEGIN
  IF has_table_privilege('first_token_metrics_reader', 'experience.chat_history', 'SELECT')
     OR has_column_privilege('first_token_metrics_reader', 'experience.chat_history', 'status', 'SELECT')
     OR has_table_privilege('first_token_metrics_reader', 'experience.chat_generation_requests', 'SELECT')
     OR has_table_privilege('first_token_metrics_reader', 'experience.chat_generation_attempts', 'SELECT')
     OR has_schema_privilege('first_token_metrics_reader', 'experience', 'USAGE') THEN
    RAISE EXCEPTION 'metrics reader still reaches experience';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'first_token_metrics_read') THEN
    RAISE EXCEPTION 'reader policies survived';
  END IF;
  SELECT string_agg(c.oid::regclass::text || ':' || r.rolname, ', ') INTO v_left
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname <> 'admin' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    AND r.rolname IN ('anon', 'authenticated');
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'browser grants left: %', v_left; END IF;
  IF NOT has_table_privilege('authenticated', 'admin.admin_users', 'SELECT') THEN
    RAISE EXCEPTION 'admin grants were touched';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'experience.chat_history'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'miniapp_traffic.botlinks'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'miniapp_traffic.traffic_clicks'::regclass) THEN
    RAISE EXCEPTION 'RLS not enabled';
  END IF;
END $chk$;

SET ROLE first_token_metrics_reader;
DO $deny$ BEGIN
  BEGIN PERFORM 1 FROM experience.chat_generation_requests; RAISE EXCEPTION 'reader read requests';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $deny$;
RESET ROLE;

SET ROLE service_role;
SELECT count(*) AS n FROM experience.chat_history \gset svc_
UPDATE experience.chat_history SET llm_finish_reason = 'length' WHERE status = 'success';
INSERT INTO miniapp_traffic.traffic_clicks VALUES (3, 1);
SELECT n AS clicks FROM miniapp_traffic.traffic_daily_stats WHERE botlink_id = 1 \gset svc_
RESET ROLE;
SELECT (:svc_n = 5 AND :svc_clicks = 3) AS svc_ok \gset
\if :svc_ok
\else
  \echo 'service_role lost access after RLS'
  SELECT 1 / 0;
\endif
SQL
echo 'OK: 20261117_db_reorg_revoke_reader_and_browser_grants.sql'
