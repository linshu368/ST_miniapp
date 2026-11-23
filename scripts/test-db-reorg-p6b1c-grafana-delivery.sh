#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261121_db_reorg_p6b1c_grafana_delivery.sql as a NON-superuser:
# - fixture functions are the production originals (md5 of prosrc);
# - the grafana day refresh returns the same rows before and after the switch (charged turn, failed turn whose charge id was
#   cleared, free turn, insufficient-balance turn), and afterwards follows usage_charges and the request, not the old columns;
# - delivery: an admitted turn delivers, a turn without a charge id is refused, a quote whose charge id differs is refused;
# - rerun is a no-op; a drifted function is refused with nothing changed.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261121_db_reorg_p6b1c_grafana_delivery.sql"
task_container="st-db-reorg-p6b1c-gd-${RANDOM}-$$"
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
  got=$(psql_f -At 2>&1)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
setup() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, billing, ops, miniapp_analytics CASCADE;
DROP TABLE IF EXISTS public.before_daily;
CREATE SCHEMA experience; CREATE SCHEMA billing; CREATE SCHEMA ops; CREATE SCHEMA miniapp_analytics;
CREATE TABLE experience.chat_history (id uuid PRIMARY KEY, user_id uuid, model text, status text, deduction_rate numeric(14,1),
  created_at timestamptz NOT NULL, llm_finish_reason text, llm_charge_id uuid, llm_billing_snapshot jsonb);
CREATE TABLE experience.chat_generation_requests (chat_history_id uuid PRIMARY KEY, requested_model_id text NOT NULL, delivery_attempt_id uuid);
CREATE TABLE experience.chat_generation_attempts (id uuid PRIMARY KEY, chat_history_id uuid NOT NULL, provider text NOT NULL,
  provider_model_id text NOT NULL, generation_id text);
CREATE FUNCTION experience.record_surplusintelligence_call(uuid, jsonb) RETURNS void LANGUAGE sql AS 'SELECT';
CREATE TABLE billing.usage_charges (id uuid PRIMARY KEY, quote jsonb NOT NULL DEFAULT '{}'::jsonb, charged_credits numeric(14,1));
CREATE TABLE billing.llm_usage_charges (charge_key uuid PRIMARY KEY, model_id text, model_display_name text NOT NULL, usage_cost_usd numeric);
CREATE TABLE billing.payment_orders (user_id uuid, status text, amount_cents integer, paid_at timestamptz);
CREATE TABLE ops.llm_calls (id uuid PRIMARY KEY, chat_history_id uuid, cost_usd numeric, cost_source text, dispatched_at timestamptz);
-- Columns exactly as in production (11-21).
CREATE TABLE miniapp_analytics.grafana_core_daily (metric_date date, metric_scope text, model_id text, model_name text, requests bigint,
  chat_users bigint, charged_requests bigint, charged_stars numeric, known_cost_requests bigint, recorded_cost_usd numeric,
  paid_orders bigint, paying_users bigint, cash_cny numeric, refreshed_at timestamptz);

-- Yesterday (Asia/Shanghai): A charged, B failed with its charge id cleared, C free, X insufficient balance.
-- D/E/F are streaming turns for the delivery checks.
CREATE TEMP TABLE t AS SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1)::timestamp AT TIME ZONE 'Asia/Shanghai' + interval '10 hours' AS at;
INSERT INTO experience.chat_history (id, user_id, model, status, deduction_rate, created_at, llm_finish_reason, llm_charge_id, llm_billing_snapshot)
SELECT v.id, v.user_id, v.model, v.status, v.rate, (SELECT at FROM t), v.finish, v.charge, v.snapshot::jsonb FROM (VALUES
  ('00000000-0000-0000-0000-00000000000a'::uuid, '00000000-0000-0000-0000-0000000000e1'::uuid, 'up/a', 'success', 10::numeric, 'stop', '00000000-0000-0000-0000-0000000001aa'::uuid,
   '{"charge_id":"00000000-0000-0000-0000-0000000001aa","model_id":"cat-a","model_display_name":"Model A","discount_rate":null}'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e2', 'up/a', 'upstream_error', 0, NULL, NULL,
   '{"charge_id":"00000000-0000-0000-0000-0000000001bb","model_id":"cat-a","model_display_name":"Model A"}'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000e1', 'up/b', 'success', 0, 'stop', '00000000-0000-0000-0000-0000000001cc',
   '{"charge_id":"00000000-0000-0000-0000-0000000001cc","model_id":"cat-b","model_display_name":"Model B"}'),
  ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000e3', 'up/a', 'insufficient_balance', 0, NULL, NULL, NULL)
) AS v(id, user_id, model, status, rate, finish, charge, snapshot);
INSERT INTO experience.chat_history (id, user_id, model, status, created_at, llm_charge_id, llm_billing_snapshot) VALUES
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000e1', 'up/a', 'streaming', now(), '00000000-0000-0000-0000-0000000001dd',
   '{"charge_id":"00000000-0000-0000-0000-0000000001dd","model_id":"cat-a"}'),
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-0000000000e1', 'up/a', 'streaming', now(), NULL,
   '{"charge_id":"00000000-0000-0000-0000-0000000001ee","model_id":"cat-a"}'),
  ('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000e1', 'up/a', 'streaming', now(), '00000000-0000-0000-0000-0000000001f0',
   '{"charge_id":"00000000-0000-0000-0000-0000000001f0","model_id":"cat-a"}');
INSERT INTO billing.usage_charges (id, quote, charged_credits)
SELECT h.llm_charge_id, jsonb_build_object('snapshot', h.llm_billing_snapshot), h.deduction_rate FROM experience.chat_history h WHERE h.llm_charge_id IS NOT NULL;
UPDATE billing.usage_charges SET quote = quote || '{"charge":{"model_id":"cat-a","model_display_name":"Model A"}}' WHERE id = '00000000-0000-0000-0000-0000000001aa';
INSERT INTO billing.llm_usage_charges VALUES ('00000000-0000-0000-0000-0000000001aa', 'cat-a', 'Model A', 0.002);
INSERT INTO experience.chat_generation_requests (chat_history_id, requested_model_id)
SELECT id, COALESCE(llm_billing_snapshot->>'model_id', 'cat-a') FROM experience.chat_history;
INSERT INTO ops.llm_calls VALUES ('00000000-0000-0000-0000-0000000003aa', '00000000-0000-0000-0000-00000000000a', 0.004, 'openrouter_metadata', now());
INSERT INTO experience.chat_generation_attempts VALUES
  ('00000000-0000-0000-0000-0000000002dd', '00000000-0000-0000-0000-00000000000d', 'openrouter', 'm/a', NULL),
  ('00000000-0000-0000-0000-0000000002ee', '00000000-0000-0000-0000-00000000000e', 'openrouter', 'm/a', NULL),
  ('00000000-0000-0000-0000-0000000002f0', '00000000-0000-0000-0000-0000000000f0', 'openrouter', 'm/a', NULL);
SQL
  psql_f >/dev/null <<'ORIGINAL_DEFS'
CREATE OR REPLACE FUNCTION miniapp_analytics.refresh_grafana_core_day(p_day date)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
    SELECT id,user_id,llm_charge_id,model,deduction_rate,
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
      -- 实扣星尘取每轮扣费额（与钱包流水 chat_debit 逐日一致）；扣费记录每用户只留 100 条，不能作来源
      GREATEST(COALESCE(h.deduction_rate,0),0) AS stars,
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
$function$;
CREATE OR REPLACE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid, p_attempt_id uuid, p_generation_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE h experience.chat_history%ROWTYPE; r experience.chat_generation_requests%ROWTYPE; a experience.chat_generation_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=p_attempt_id AND chat_history_id=p_history_id FOR UPDATE;
  -- Either attempt may win; the immutable delivery_attempt_id below arbitrates once.
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  IF r.delivery_attempt_id IS NOT NULL THEN
    IF r.delivery_attempt_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Delivery already belongs to another attempt' USING ERRCODE='PT409';
  END IF;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL OR h.llm_billing_snapshot->>'charge_id' IS DISTINCT FROM h.llm_charge_id::text THEN
    RAISE EXCEPTION 'Cancelled/ended generation cannot choose delivery' USING ERRCODE='PT409';
  END IF;
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- db reorg 6a-2c-1: the delivered attempt is the only call identity; OpenRouter / Venice
  -- metadata lives in ops.llm_calls, written by experience.record_llm_call_metadata.
  IF a.provider='surplus' THEN
    -- Losing Surplus attempts may coexist with an OpenRouter winner; only this RPC
    -- chooses billing/delivery ownership. The call table never changes the parent.
    PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));
  ELSIF a.provider NOT IN ('openrouter','venice') THEN
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
  END IF;
  -- The entire quote stays intact; only these two routing fields are bound to delivery.
  UPDATE experience.chat_history SET llm_billing_snapshot=llm_billing_snapshot || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id) WHERE id=p_history_id;
  UPDATE experience.chat_generation_attempts SET generation_id=COALESCE(generation_id,p_generation_id) WHERE id=p_attempt_id;
  UPDATE experience.chat_generation_requests SET delivery_attempt_id=p_attempt_id WHERE chat_history_id=p_history_id;
END;
$function$;
ORIGINAL_DEFS
}
daily() {
  cat <<'SQL'
SELECT metric_scope, model_id, model_name, requests, chat_users, charged_requests, charged_stars, known_cost_requests, recorded_cost_usd
FROM miniapp_analytics.grafana_core_daily
SQL
}
deliver() { # history id, attempt id -> "ok" or the SQLSTATE
  psql_f -At <<SQL 2>&1 | tail -1
DO \$\$ BEGIN PERFORM experience.select_chat_generation_delivery('$1', '$2', 'gen-x'); RAISE NOTICE 'ok';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE '%', SQLSTATE; END \$\$;
SQL
}

setup
check 'fixture functions are the production originals' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['11ea797699ac67b5a2f61162bc153075', '8a876c2ed31463dded90de7850b2eadd']
FROM pg_proc WHERE proname IN ('refresh_grafana_core_day', 'select_chat_generation_delivery');
SQL
psql_f -c "SELECT miniapp_analytics.refresh_grafana_core_day((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1)" >/dev/null
psql_f >/dev/null <<SQL
CREATE TABLE public.before_daily AS $(daily);
SQL
check 'baseline: model A counts the cleared failed turn under the selected model; cost and stars as expected' <<'SQL'
SELECT (SELECT requests FROM public.before_daily WHERE model_id = 'cat-a') = 2
   AND (SELECT model_name FROM public.before_daily WHERE model_id = 'cat-a') = 'Model A'
   AND (SELECT charged_stars FROM public.before_daily WHERE metric_scope = 'overall') = 10
   AND (SELECT recorded_cost_usd FROM public.before_daily WHERE metric_scope = 'overall') = 0.004;
SQL
[[ $(deliver 00000000-0000-0000-0000-00000000000e 00000000-0000-0000-0000-0000000002ee) == *PT409* ]] || { echo 'FAIL: baseline refuses a turn without charge id'; exit 1; }

out=$(psql_f <"$migration" 2>&1)
[[ $(grep -c 'now reads usage_charges' <<<"$out") == 2 && "$out" == *'grafana rows identical before and after (3 rows)'* ]] || { echo "FAIL: apply: $out"; exit 1; }
echo 'ok: applied; in-migration refresh of yesterday identical before and after'
psql_f -c "SELECT miniapp_analytics.refresh_grafana_core_day((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1)" >/dev/null
check 'grafana rows identical to the original function' <<SQL
SELECT NOT EXISTS (SELECT * FROM public.before_daily EXCEPT ALL $(daily)) AND NOT EXISTS ($(daily) EXCEPT ALL SELECT * FROM public.before_daily);
SQL
check 'grafana follows usage_charges and the request, not the old columns' <<'SQL'
UPDATE experience.chat_history SET llm_billing_snapshot = '{"model_id":"stale"}', deduction_rate = 99 WHERE id = '00000000-0000-0000-0000-00000000000a';
UPDATE billing.usage_charges SET charged_credits = 12 WHERE id = '00000000-0000-0000-0000-0000000001aa';
UPDATE experience.chat_generation_requests SET requested_model_id = 'cat-b' WHERE chat_history_id = '00000000-0000-0000-0000-00000000000b';
SELECT miniapp_analytics.refresh_grafana_core_day((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1) \gset
SELECT (SELECT charged_stars FROM miniapp_analytics.grafana_core_daily WHERE metric_scope = 'overall') = 12
   AND (SELECT requests FROM miniapp_analytics.grafana_core_daily WHERE model_id = 'cat-a') = 1
   AND (SELECT requests || '/' || model_name FROM miniapp_analytics.grafana_core_daily WHERE model_id = 'cat-b') = '2/Model B'
   AND NOT EXISTS (SELECT 1 FROM miniapp_analytics.grafana_core_daily WHERE model_id IN ('stale', 'up/a'));
SQL
[[ $(deliver 00000000-0000-0000-0000-00000000000d 00000000-0000-0000-0000-0000000002dd) == *ok* ]] || { echo 'FAIL: admitted turn should deliver'; exit 1; }
[[ $(deliver 00000000-0000-0000-0000-00000000000e 00000000-0000-0000-0000-0000000002ee) == *PT409* ]] || { echo 'FAIL: turn without charge id should be refused'; exit 1; }
psql_f -c "UPDATE billing.usage_charges SET quote = jsonb_set(quote, '{snapshot,charge_id}', '\"other\"') WHERE id = '00000000-0000-0000-0000-0000000001f0'" >/dev/null
[[ $(deliver 00000000-0000-0000-0000-0000000000f0 00000000-0000-0000-0000-0000000002f0) == *PT409* ]] || { echo 'FAIL: quote with another charge id should be refused'; exit 1; }
check 'delivery: admitted turn delivered and bound, the other two refused' <<'SQL'
SELECT (SELECT delivery_attempt_id FROM experience.chat_generation_requests WHERE chat_history_id = '00000000-0000-0000-0000-00000000000d') = '00000000-0000-0000-0000-0000000002dd'
   AND (SELECT llm_billing_snapshot->>'provider' FROM experience.chat_history WHERE id = '00000000-0000-0000-0000-00000000000d') = 'openrouter'
   AND (SELECT delivery_attempt_id FROM experience.chat_generation_requests WHERE chat_history_id = '00000000-0000-0000-0000-00000000000e') IS NULL;
SQL
out=$(psql_f <"$migration" 2>&1)
[[ $(grep -c 'already reads usage_charges' <<<"$out") == 2 && "$out" != *'identical before and after'* ]] || { echo "FAIL: rerun: $out"; exit 1; }
echo 'ok: rerun is a no-op'

setup
psql_f -c "CREATE OR REPLACE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid, p_attempt_id uuid, p_generation_id text) RETURNS void LANGUAGE plpgsql AS \$\$ BEGIN RETURN; END \$\$" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: drift should refuse"; exit 1; fi
[[ "$out" == *'select_chat_generation_delivery'*'drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'a drifted function rolls the whole switch back' <<'SQL'
SELECT md5(prosrc) = '11ea797699ac67b5a2f61162bc153075' FROM pg_proc WHERE proname = 'refresh_grafana_core_day';
SQL
echo 'all checks passed'
