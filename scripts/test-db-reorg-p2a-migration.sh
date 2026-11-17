#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_core_refresh_bounded.sql as a NON-superuser with CREATEROLE (like Supabase's postgres):
# the rewritten refresh_grafana_core_day returns exactly the same daily rows as the 20261026 version on random
# synthetic data (cross-midnight vendor rows, shared charge keys, empty model ids, non-numeric usage, missing
# charges, insufficient balance); idempotent re-run; cron split into today/yesterday jobs; ACL not broadened;
# without pg_cron only the function is installed.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migrations="$task_root/packages/shared/migrations"
migration="$migrations/20261117_db_reorg_core_refresh_bounded.sql"
task_container="st-db-reorg-p2a-${RANDOM}-$$"
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
"${admin_psql[@]}" >/dev/null < "$migrations/tests/grafana_light_core_bootstrap.sql"
# Production vendor tables carry created_at with an index; the bootstrap fixture predates that need.
"${admin_psql[@]}" >/dev/null <<'SQL'
ALTER TABLE experience.openrouter_chat_history ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE experience.venice_chat_history ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX ON experience.openrouter_chat_history(created_at DESC);
CREATE INDEX ON experience.venice_chat_history(created_at DESC);
SQL
"${admin_psql[@]}" >/dev/null < "$migrations/20261026_grafana_light_core.sql"

# Keep the 20261026 body under another name as the reference implementation.
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  EXECUTE replace(pg_get_functiondef('miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure),
    'miniapp_analytics.refresh_grafana_core_day(p_day date)', 'miniapp_analytics.refresh_core_reference(p_day date)');
END $$;
SQL

"${admin_psql[@]}" >/dev/null < "$migration"
"${admin_psql[@]}" >/dev/null < "$migration"

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE SCHEMA test_fixture;
SELECT setseed(0.17);
CREATE TABLE test_fixture.rows AS
SELECT g,
  gen_random_uuid() AS id,
  md5('user' || (g % 25))::uuid AS user_id,
  ((x.d - 2)::timestamp AT TIME ZONE 'Asia/Shanghai') + random() * interval '3 days' AS created_at,
  CASE WHEN g % 50 = 0 THEN md5('shared' || (g % 3))::uuid WHEN random() < 0.8 THEN gen_random_uuid() END AS charge,
  (ARRAY['m-a', 'm-b', '', 'm-c', NULL])[1 + floor(random() * 5)::int] AS model,
  CASE WHEN random() < 0.05 THEN 'insufficient_balance' WHEN random() < 0.1 THEN 'upstream_error' ELSE 'success' END AS status,
  CASE floor(random() * 4)::int
    WHEN 0 THEN NULL
    WHEN 1 THEN '{"model_id":"sel-a","model_display_name":"Sel A"}'::jsonb
    WHEN 2 THEN '{"model_id":""}'::jsonb
    ELSE '{"model_id":"sel-b"}'::jsonb END AS snap,
  random() AS r_or, random() AS r_ve, random() * 115 AS lag_s
FROM generate_series(1, 3000) g, (SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d) x;
-- One second before each Beijing midnight, with the vendor row landing after midnight.
INSERT INTO test_fixture.rows
SELECT 100000 + k, gen_random_uuid(), md5('edge' || k)::uuid,
  ((x.d - k)::timestamp AT TIME ZONE 'Asia/Shanghai') - interval '1 second',
  NULL::uuid, 'm-edge', 'success', NULL, 0.9, 0.9, 111
FROM generate_series(0, 2) k, (SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d) x;

INSERT INTO experience.chat_history(id, user_id, created_at, llm_charge_id, model, status, llm_billing_snapshot)
SELECT id, user_id, created_at, charge, model, status, snap FROM test_fixture.rows;
INSERT INTO billing.llm_usage_charges(charge_key, model_id, model_display_name, status, charged_amount, usage_cost_usd)
SELECT charge,
  (ARRAY['c-a', '', NULL, 'c-b'])[1 + floor(random() * 4)::int],
  (ARRAY['C A', '', NULL])[1 + floor(random() * 3)::int],
  (ARRAY['charged', 'partial', 'reconciled', 'historical', 'free', 'refunded', 'pending'])[1 + floor(random() * 7)::int],
  CASE WHEN random() < 0.1 THEN NULL WHEN random() < 0.05 THEN -3 ELSE round((random() * 40)::numeric, 2) END,
  CASE WHEN random() < 0.5 THEN NULL ELSE round((random() * 0.02)::numeric, 6) END
FROM (SELECT DISTINCT charge FROM test_fixture.rows WHERE charge IS NOT NULL AND g % 7 <> 0) c;
INSERT INTO experience.openrouter_chat_history(chat_history_id, usage, created_at)
SELECT id,
  CASE WHEN random() < 0.8 THEN to_jsonb(round((random() * 0.01)::numeric, 6)) WHEN random() < 0.5 THEN '"n/a"'::jsonb ELSE '{"cost":1}'::jsonb END,
  created_at + lag_s * interval '1 second'
FROM test_fixture.rows WHERE r_or < 0.4;
INSERT INTO experience.venice_chat_history(chat_history_id, llm_usage, created_at)
SELECT id,
  CASE WHEN random() < 0.8 THEN to_jsonb(floor(random() * 9000)::bigint) ELSE 'null'::jsonb END,
  created_at + lag_s * interval '1 second'
FROM test_fixture.rows WHERE r_ve < 0.15;
INSERT INTO experience.openrouter_chat_history(chat_history_id, usage, created_at)
SELECT id, to_jsonb(0.004), created_at + lag_s * interval '1 second' FROM test_fixture.rows WHERE g >= 100000;
INSERT INTO billing.payment_orders(user_id, status, paid_at, amount_cents)
SELECT md5('user' || (g % 25))::uuid,
  (ARRAY['completed', 'pending', 'failed'])[1 + floor(random() * 3)::int],
  ((x.d - 2)::timestamp AT TIME ZONE 'Asia/Shanghai') + random() * interval '3 days',
  (100 + floor(random() * 5000))::bigint
FROM generate_series(1, 200) g, (SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d) x;
SQL

"${admin_psql[@]}" <<'SQL'
\set QUIET on
CREATE TABLE test_fixture.cmp_reference AS SELECT * FROM miniapp_analytics.grafana_core_daily WHERE false;
CREATE TABLE test_fixture.cmp_bounded AS SELECT * FROM miniapp_analytics.grafana_core_daily WHERE false;
DO $chk$
DECLARE
  d date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  k int;
  v_diff bigint;
  v_vendor_only bigint;
BEGIN
  IF position('day_openrouter' IN (SELECT prosrc FROM pg_proc WHERE oid = 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'bounded function not installed';
  END IF;
  FOR k IN 0..2 LOOP
    PERFORM miniapp_analytics.refresh_core_reference(d - k);
    INSERT INTO test_fixture.cmp_reference SELECT * FROM miniapp_analytics.grafana_core_daily WHERE metric_date = d - k;
    PERFORM miniapp_analytics.refresh_grafana_core_day(d - k);
    INSERT INTO test_fixture.cmp_bounded SELECT * FROM miniapp_analytics.grafana_core_daily WHERE metric_date = d - k;
  END LOOP;

  SELECT count(*) INTO v_diff FROM (
    (SELECT metric_date, metric_scope, model_id, model_name, requests, chat_users, charged_requests, charged_stars,
            known_cost_requests, recorded_cost_usd, paid_orders, paying_users, cash_cny FROM test_fixture.cmp_reference
     EXCEPT ALL
     SELECT metric_date, metric_scope, model_id, model_name, requests, chat_users, charged_requests, charged_stars,
            known_cost_requests, recorded_cost_usd, paid_orders, paying_users, cash_cny FROM test_fixture.cmp_bounded)
    UNION ALL
    (SELECT metric_date, metric_scope, model_id, model_name, requests, chat_users, charged_requests, charged_stars,
            known_cost_requests, recorded_cost_usd, paid_orders, paying_users, cash_cny FROM test_fixture.cmp_bounded
     EXCEPT ALL
     SELECT metric_date, metric_scope, model_id, model_name, requests, chat_users, charged_requests, charged_stars,
            known_cost_requests, recorded_cost_usd, paid_orders, paying_users, cash_cny FROM test_fixture.cmp_reference)
  ) x;
  IF v_diff <> 0 THEN RAISE EXCEPTION 'bounded refresh differs from reference in % rows', v_diff; END IF;
  IF (SELECT count(*) FROM test_fixture.cmp_reference WHERE metric_scope = 'overall') <> 3
     OR (SELECT count(*) FROM test_fixture.cmp_reference) < 12 THEN
    RAISE EXCEPTION 'comparison too thin: % rows', (SELECT count(*) FROM test_fixture.cmp_reference);
  END IF;

  -- The comparison must exercise vendor-only cost, including the cross-midnight rows.
  SELECT count(*) INTO v_vendor_only FROM test_fixture.rows t
  LEFT JOIN billing.llm_usage_charges c ON c.charge_key = t.charge
  WHERE t.status <> 'insufficient_balance' AND c.usage_cost_usd IS NULL
    AND t.created_at >= ((d - 2)::timestamp AT TIME ZONE 'Asia/Shanghai')
    AND (t.r_or < 0.4 OR t.r_ve < 0.15 OR t.g >= 100000);
  IF v_vendor_only < 100 THEN RAISE EXCEPTION 'too few vendor-only cost rows: %', v_vendor_only; END IF;
  IF NOT EXISTS (SELECT 1 FROM test_fixture.cmp_bounded WHERE model_id = 'm-edge' AND metric_date = d - 1 AND known_cost_requests = 1) THEN
    RAISE EXCEPTION 'cross-midnight vendor cost lost';
  END IF;

  IF has_function_privilege('anon', 'miniapp_analytics.refresh_grafana_core_day(date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_analytics.refresh_grafana_core_day(date)', 'EXECUTE')
     OR has_function_privilege('first_token_metrics_reader', 'miniapp_analytics.refresh_grafana_core_day(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'refresh privilege broadened';
  END IF;
  IF NOT has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.grafana_core_daily', 'SELECT') THEN
    RAISE EXCEPTION 'reader lost SELECT';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'grafana_core_recent_30m' AND schedule = '7,37 * * * *'
       AND command LIKE '%statement_timeout=''20s''%' AND command LIKE '%refresh_grafana_core_day(%'
       AND command NOT LIKE '%::date-1%')
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'grafana_core_yesterday_close' AND schedule = '17 16-22 * * *'
       AND command LIKE '%statement_timeout=''30s''%' AND command LIKE '%::date-1)%')
     OR (SELECT count(*) FROM cron.job WHERE jobname LIKE 'grafana_core%') <> 2
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'unrelated_job') THEN
    RAISE EXCEPTION 'cron split wrong: %', (SELECT json_agg(j) FROM cron.job j);
  END IF;
END $chk$;
SQL
echo "PASS: bounded refresh equals reference on 3 random days; ACL; cron split; idempotent"

"${admin_psql[@]}" -c 'DROP SCHEMA cron CASCADE' >/dev/null
"${admin_psql[@]}" >/dev/null < "$migration"
echo "PASS: without pg_cron only the function is installed"
echo 'OK: 20261117_db_reorg_core_refresh_bounded.sql'
