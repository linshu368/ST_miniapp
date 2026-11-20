#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c3_core_daily_cost.sql as a NON-superuser:
# - the fixture is the production body of refresh_grafana_core_day (md5 aca12800…);
# - before: cost = usage charge, else max OpenRouter / Venice (no Surplus, no fallback), calls by created_at window;
# - after: cost = every call of the turn (first + fallback, all providers); a turn with a call still waiting for
#   its cost is not "known"; a turn without calls keeps the usage charge cost; calls rebuilt by the expand
#   (created_at = migration time) count for their turn's day; md5 after the patch;
# - only dispatched calls past the cost job window are labelled unavailable (history rows without dispatch kept);
#   14 days refreshed;
# - rerun is a no-op; a drifted function is refused and nothing is labelled.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2c3_core_daily_cost.sql"
task_container="st-db-reorg-p6a2c3k-${RANDOM}-$$"
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
fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, ops, billing, miniapp_analytics CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA ops; CREATE SCHEMA billing; CREATE SCHEMA miniapp_analytics;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, llm_charge_id text, model text, llm_billing_snapshot jsonb,
  status text NOT NULL DEFAULT 'completed', created_at timestamptz NOT NULL);
CREATE TABLE billing.llm_usage_charges (
  charge_key text PRIMARY KEY, model_id text, model_display_name text, status text, charged_amount numeric, usage_cost_usd numeric);
CREATE TABLE billing.payment_orders (user_id uuid, status text, paid_at timestamptz, amount_cents bigint);
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL, provider text NOT NULL, role text, cost_usd numeric, cost_source text,
  dispatched_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE miniapp_analytics.grafana_core_daily (
  metric_date date NOT NULL, metric_scope text NOT NULL, model_id text NOT NULL, model_name text NOT NULL,
  requests bigint NOT NULL, chat_users bigint NOT NULL, charged_requests bigint NOT NULL, charged_stars numeric NOT NULL,
  known_cost_requests bigint NOT NULL, recorded_cost_usd numeric, paid_orders bigint, paying_users bigint, cash_cny numeric,
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY (metric_date, metric_scope, model_id),
  CHECK ((metric_scope = 'overall' AND model_id = '__all__') OR (metric_scope = 'model' AND model_id <> '__all__')),
  CHECK (known_cost_requests <= requests AND chat_users <= requests),
  CHECK (metric_scope IN ('overall', 'model')));
CREATE FUNCTION pg_temp.day0() RETURNS timestamptz LANGUAGE sql
  AS $f$ SELECT ((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai' $f$;
-- today: T1 paid (charge cost 0.001; primary estimated 0.002 + OpenRouter fallback 0.003)
--        T2 free zone (Surplus 0.0004 + Surplus slot unavailable + Venice fallback 0.0001)
--        T3 OpenRouter 0.001 + a fallback still waiting for its cost
--        T4 no call rows, charge cost 0.002
-- yesterday: T5 OpenRouter 0.007 on a row rebuilt by the expand (created_at = now)
INSERT INTO experience.chat_history (id, user_id, llm_charge_id, model, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-00aa-000000000001', 'c1', 'm/paid', pg_temp.day0() + interval '1 second'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-00aa-000000000002', NULL, 'm/free', pg_temp.day0() + interval '2 seconds'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-00aa-000000000001', NULL, 'm/paid', pg_temp.day0() + interval '3 seconds'),
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-00aa-000000000003', 'c4', 'm/paid', pg_temp.day0() + interval '4 seconds'),
  ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-00aa-000000000001', NULL, 'm/paid', pg_temp.day0() - interval '12 hours');
INSERT INTO billing.llm_usage_charges VALUES ('c1', 'm/paid', 'Paid', 'charged', 10, 0.001), ('c4', 'm/paid', 'Paid', 'charged', 5, 0.002);
INSERT INTO ops.llm_calls (id, chat_history_id, provider, role, cost_usd, cost_source, dispatched_at, created_at) VALUES
  ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0000-000000000001', 'openrouter', 'primary', 0.002, 'estimated', now(), pg_temp.day0() + interval '1 second'),
  ('00000000-0000-0000-0001-000000000002', '00000000-0000-0000-0000-000000000001', 'openrouter', 'fallback', 0.003, 'openrouter_usage', now(), pg_temp.day0() + interval '1 second'),
  ('00000000-0000-0000-0001-000000000003', '00000000-0000-0000-0000-000000000002', 'surplus', 'primary', 0.0004, 'surplus_buyer', now(), pg_temp.day0() + interval '2 seconds'),
  ('00000000-0000-0000-0001-000000000004', '00000000-0000-0000-0000-000000000002', 'surplus', 'primary', NULL, 'unavailable', now(), pg_temp.day0() + interval '2 seconds'),
  ('00000000-0000-0000-0001-000000000005', '00000000-0000-0000-0000-000000000002', 'venice', 'fallback', 0.0001, 'venice_usage', now(), pg_temp.day0() + interval '2 seconds'),
  ('00000000-0000-0000-0001-000000000006', '00000000-0000-0000-0000-000000000003', 'openrouter', 'primary', 0.001, 'openrouter_usage', now(), pg_temp.day0() + interval '3 seconds'),
  ('00000000-0000-0000-0001-000000000007', '00000000-0000-0000-0000-000000000003', 'openrouter', 'fallback', NULL, NULL, now(), pg_temp.day0() + interval '3 seconds'),
  ('00000000-0000-0000-0001-000000000008', '00000000-0000-0000-0000-000000000005', 'openrouter', 'primary', 0.007, 'openrouter_usage', now(), pg_temp.day0() + interval '2 hours'),
-- outside the cost job window: past 7 days (labelled); old history row without dispatch and in-flight row (both kept)
  ('00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0000-000000000009', 'surplus', 'primary', NULL, NULL, now() - interval '8 days', now() - interval '8 days'),
  ('00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0000-000000000009', 'openrouter', NULL, NULL, NULL, NULL, now() - interval '2 days'),
  ('00000000-0000-0000-0002-000000000003', '00000000-0000-0000-0000-000000000009', 'surplus', 'primary', NULL, NULL, NULL, now());
SQL
  psql_f >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION miniapp_analytics.refresh_grafana_core_day(p_day date)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $prodfn$
DECLARE
  v_today date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF p_day IS NULL OR p_day<v_today-13 OR p_day>v_today THEN
    RAISE EXCEPTION 'Only one day within the last 14 days is refreshable';
  END IF;
  IF NOT pg_try_advisory_xact_lock(20261026,510) THEN RETURN false; END IF;
  v_start := p_day::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end := (p_day+1)::timestamp AT TIME ZONE 'Asia/Shanghai';
  DELETE FROM miniapp_analytics.grafana_core_daily WHERE metric_date=p_day;
  WITH day_history AS MATERIALIZED (
    SELECT id,user_id,llm_charge_id,model,
      llm_billing_snapshot->>'model_id' AS selected_model_id,
      llm_billing_snapshot->>'model_display_name' AS selected_model_name
    FROM experience.chat_history
    WHERE created_at>=v_start AND created_at<v_end AND status<>'insufficient_balance'
  ), day_calls AS MATERIALIZED (
    -- 调用元数据在聊天记录之后写入；窗口两端各留余量。ops.llm_calls 成本统一为美元（数据库重组 6a-2c-1）。
    SELECT chat_history_id,
      max(cost_usd) FILTER (WHERE provider='openrouter') AS openrouter_cost_usd,
      max(cost_usd) FILTER (WHERE provider='venice') AS venice_cost_usd
    FROM ops.llm_calls
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
      AND provider IN ('openrouter','venice')
    GROUP BY chat_history_id
  ), facts AS MATERIALIZED (
    SELECT h.user_id,
      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(c.model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(c.model_display_name,''),NULLIF(h.model,''),'unknown') AS model_name,
      CASE WHEN c.status IN ('charged','partial','reconciled','historical')
        THEN GREATEST(COALESCE(c.charged_amount,0),0) ELSE 0 END AS stars,
      COALESCE(c.usage_cost_usd,
        o.openrouter_cost_usd, o.venice_cost_usd) AS cost_usd
    FROM day_history h
    LEFT JOIN billing.llm_usage_charges c ON c.charge_key=h.llm_charge_id
    LEFT JOIN day_calls o ON o.chat_history_id=h.id
  )
  INSERT INTO miniapp_analytics.grafana_core_daily
    (metric_date,metric_scope,model_id,model_name,requests,chat_users,
     charged_requests,charged_stars,known_cost_requests,recorded_cost_usd,refreshed_at)
  SELECT p_day,CASE WHEN grouping(model_id)=1 THEN 'overall' ELSE 'model' END,
    CASE WHEN grouping(model_id)=1 THEN '__all__' ELSE model_id END,
    CASE WHEN grouping(model_id)=1 THEN '全部型号' ELSE max(model_name) END,
    count(*),count(DISTINCT user_id),count(*) FILTER(WHERE stars>0),COALESCE(sum(stars),0),
    count(*) FILTER(WHERE cost_usd>=0),sum(cost_usd) FILTER(WHERE cost_usd>=0),clock_timestamp()
  FROM facts GROUP BY GROUPING SETS ((model_id),());

  UPDATE miniapp_analytics.grafana_core_daily d SET
    paid_orders=p.orders,paying_users=p.users,cash_cny=p.cash
  FROM (
    SELECT count(*) AS orders,count(DISTINCT user_id) AS users,
      COALESCE(sum(amount_cents),0)::numeric/100 AS cash
    FROM billing.payment_orders
    WHERE status='completed' AND paid_at>=v_start AND paid_at<v_end
  ) p WHERE d.metric_date=p_day AND d.metric_scope='overall';
  DELETE FROM miniapp_analytics.grafana_core_daily WHERE metric_date<v_today-13;
  RETURN true;
END;
$prodfn$;
SQL
}
day_row() { # $1 = 0 today / 1 yesterday -> "requests,known,cost"
  psql_f -At -c "SELECT requests || ',' || known_cost_requests || ',' || COALESCE(round(recorded_cost_usd, 6)::text, 'null')
    FROM miniapp_analytics.grafana_core_daily
    WHERE metric_scope = 'overall' AND metric_date = (now() AT TIME ZONE 'Asia/Shanghai')::date - $1"
}

fixture
check 'fixture is the production body' <<'SQL'
SELECT md5(prosrc) = 'aca128007b4aa43ab3e93dc4255bea47' FROM pg_proc WHERE proname = 'refresh_grafana_core_day';
SQL
psql_f -c "SELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date - d) FROM (VALUES (0), (1)) v(d)" >/dev/null
[[ "$(day_row 0)" == '4,4,0.004100' && "$(day_row 1)" == '1,0,null' ]] ||
  { echo "FAIL: old semantics today=$(day_row 0) yesterday=$(day_row 1)"; exit 1; }
echo 'ok: before: charge cost or one provider max, no Surplus / fallback; rebuilt row missed'
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'now sums every call of the turn'* && "$out" == *'1 calls outside the cost job window labelled unavailable'* &&
   "$out" == *'14 days of grafana_core_daily refreshed'* ]] || { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: apply patched the function, labelled 1 call, refreshed 14 days'
[[ "$(day_row 0)" == '4,3,0.007500' && "$(day_row 1)" == '1,1,0.007000' ]] ||
  { echo "FAIL: new semantics today=$(day_row 0) yesterday=$(day_row 1)"; exit 1; }
echo 'ok: after: every call summed; waiting turn not known; no-call turn keeps charge cost; rebuilt row counted'
check 'md5 after the patch; 14 days present; model rows kept' <<'SQL'
SELECT (SELECT md5(prosrc) = '98cab2eb3a011c1faeb93d7bed9d1341' FROM pg_proc WHERE proname = 'refresh_grafana_core_day')
  AND (SELECT count(DISTINCT metric_date) = 14 FROM miniapp_analytics.grafana_core_daily)
  AND (SELECT known_cost_requests = 2 AND round(recorded_cost_usd, 6) = 0.007 FROM miniapp_analytics.grafana_core_daily
       WHERE metric_scope = 'model' AND model_id = 'm/paid' AND metric_date = (now() AT TIME ZONE 'Asia/Shanghai')::date);
SQL
check 'only dispatched calls past the job window labelled; pending, history and in-flight rows untouched' <<'SQL'
SELECT array_agg(right(id::text, 2) || ':' || COALESCE(cost_source, '-') ORDER BY id)
  = ARRAY['07:-', '01:unavailable', '02:-', '03:-']
FROM ops.llm_calls WHERE id::text LIKE '00000000-0000-0000-0002-%' OR id = '00000000-0000-0000-0001-000000000007';
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'already uses per-turn total cost'* && "$out" == *'0 calls outside'* && "$out" == *'14 days of'* ]] ||
  { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun is a no-op (refresh only)'

fixture
psql_f >/dev/null <<'SQL'
DO $d$ BEGIN
  EXECUTE replace(pg_get_functiondef('miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure),
                  'RETURN true;', 'RETURN true ;');
END $d$;
SQL
if out=$(psql_f <"$migration" 2>&1); then echo 'FAIL: drifted function not refused'; exit 1; fi
[[ "$out" == *'drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'refusal labelled nothing' <<'SQL'
SELECT count(*) = 0 FROM ops.llm_calls WHERE id::text LIKE '00000000-0000-0000-0002-%' AND cost_source IS NOT NULL;
SQL
echo 'all checks passed'
