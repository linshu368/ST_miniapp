#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6a2c3_core_daily_stars.sql as a NON-superuser:
# - the fixture is the current production body of refresh_grafana_core_day (md5 98cab2eb…);
# - before: stars / charged requests come from billing.llm_usage_charges, so a pruned charge row is missed;
# - after: stars = per-turn chat_history.deduction_rate (wallet-ledger equal), pruned rows no longer matter;
#   costs unchanged; md5 after the patch; 14 days refreshed;
# - rerun is a no-op; a drifted function is refused.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261120_db_reorg_p6a2c3_core_daily_stars.sql"
task_container="st-db-reorg-p6a2c3s2-${RANDOM}-$$"
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
  deduction_rate numeric, status text NOT NULL DEFAULT 'completed', created_at timestamptz NOT NULL);
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
-- today: T1 paid 10 (charge kept, cost 0.005 from calls), T2 free turn (0 stars, cost 0.0005),
--        T3 paid 7 whose charge row was pruned (cost from its call 0.001), T4 paid 5 (no calls, charge cost 0.002)
INSERT INTO experience.chat_history (id, user_id, llm_charge_id, model, deduction_rate, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-00aa-000000000001', 'c1', 'm/paid', 10, pg_temp.day0() + interval '1 second'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-00aa-000000000002', NULL, 'm/free', 0, pg_temp.day0() + interval '2 seconds'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-00aa-000000000001', 'c3', 'm/paid', 7, pg_temp.day0() + interval '3 seconds'),
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-00aa-000000000003', 'c4', 'm/paid', 5, pg_temp.day0() + interval '4 seconds');
INSERT INTO billing.llm_usage_charges VALUES ('c1', 'm/paid', 'Paid', 'charged', 10, 0.001), ('c4', 'm/paid', 'Paid', 'charged', 5, 0.002);
INSERT INTO ops.llm_calls (id, chat_history_id, provider, role, cost_usd, cost_source, dispatched_at) VALUES
  ('00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0000-000000000001', 'openrouter', 'primary', 0.002, 'estimated', now()),
  ('00000000-0000-0000-0001-000000000002', '00000000-0000-0000-0000-000000000001', 'openrouter', 'fallback', 0.003, 'openrouter_usage', now()),
  ('00000000-0000-0000-0001-000000000003', '00000000-0000-0000-0000-000000000002', 'surplus', 'primary', 0.0005, 'surplus_buyer', now()),
  ('00000000-0000-0000-0001-000000000004', '00000000-0000-0000-0000-000000000003', 'openrouter', 'primary', 0.001, 'openrouter_usage', now());
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
    -- 每轮成本 = 首发 + 兜底全部上游调用（三家供应商，统一美元），与 miniapp_analytics.llm_turn_costs 同口径。
    -- 按当天轮次 id 关联（扩展迁移补建的行 created_at 不是轮次时间）；还有调用在等成本补查的轮次先不算已记录成本。
    SELECT l.chat_history_id,
      sum(COALESCE(l.cost_usd,0)) FILTER (WHERE l.cost_source IS NOT NULL) AS cost_usd,
      bool_or(l.cost_source IS NULL AND l.dispatched_at IS NOT NULL) AS cost_pending
    FROM ops.llm_calls l
    WHERE l.chat_history_id IN (SELECT id FROM day_history)
    GROUP BY l.chat_history_id
  ), facts AS MATERIALIZED (
    SELECT h.user_id,
      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(c.model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(c.model_display_name,''),NULLIF(h.model,''),'unknown') AS model_name,
      CASE WHEN c.status IN ('charged','partial','reconciled','historical')
        THEN GREATEST(COALESCE(c.charged_amount,0),0) ELSE 0 END AS stars,
      CASE WHEN o.cost_pending THEN NULL
        ELSE COALESCE(o.cost_usd, c.usage_cost_usd) END AS cost_usd
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
today_row() { # "requests,charged,stars,known,cost"
  psql_f -At -c "SELECT requests || ',' || charged_requests || ',' || charged_stars || ',' || known_cost_requests || ',' || round(recorded_cost_usd, 6)
    FROM miniapp_analytics.grafana_core_daily
    WHERE metric_scope = 'overall' AND metric_date = (now() AT TIME ZONE 'Asia/Shanghai')::date"
}

fixture
check 'fixture is the current production body' <<'SQL'
SELECT md5(prosrc) = '98cab2eb3a011c1faeb93d7bed9d1341' FROM pg_proc WHERE proname = 'refresh_grafana_core_day';
SQL
psql_f -c "SELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date)" >/dev/null
[[ "$(today_row)" == '4,2,15,4,0.008500' ]] || { echo "FAIL: before: $(today_row)"; exit 1; }
echo 'ok: before: the pruned charge row is missed (15 stars, 2 charged)'
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'now reads stars from deduction_rate'* && "$out" == *'14 days of grafana_core_daily refreshed'* ]] ||
  { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: apply patched the function and refreshed 14 days'
[[ "$(today_row)" == '4,3,22,4,0.008500' ]] || { echo "FAIL: after: $(today_row)"; exit 1; }
echo 'ok: after: stars = per-turn deduction (22, 3 charged); costs unchanged'
check 'md5 after the patch; 14 days; model rows follow' <<'SQL'
SELECT (SELECT md5(prosrc) = '11ea797699ac67b5a2f61162bc153075' FROM pg_proc WHERE proname = 'refresh_grafana_core_day')
  AND (SELECT count(DISTINCT metric_date) = 14 FROM miniapp_analytics.grafana_core_daily)
  AND (SELECT charged_stars = 22 AND charged_requests = 3 FROM miniapp_analytics.grafana_core_daily
       WHERE metric_scope = 'model' AND model_id = 'm/paid' AND metric_date = (now() AT TIME ZONE 'Asia/Shanghai')::date);
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'already reads deduction_rate'* && "$out" == *'14 days of'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
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
echo 'ok: drifted function refused'
echo 'all checks passed'
