#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c1_llm_calls_contract.sql (after the expand) as a NON-superuser with CREATEROLE:
# - fixture functions select_chat_generation_delivery and refresh_grafana_core_day are the production bodies (md5);
# - phase 1 stops the delivery RPC writing detail tables (OpenRouter / Venice / Surplus / unknown provider / repeat /
#   competing winner behave as before otherwise) and moves the Grafana cost read to ops.llm_calls with identical
#   daily rows;
# - phase 2 copies rows written after the expand (filling only empty ops values, never overwriting newer ones),
#   refuses (leaving the tables) when a settled turn would report a different cost, and drops both tables once clean;
# - rerunning the same file after a phase-2 failure skips phase 1 and finishes; a further rerun changes nothing.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
mig="$task_root/packages/shared/migrations"
expand="$mig/20261119_db_reorg_p6a2c1_llm_calls_expand.sql"
contract="$mig/20261119_db_reorg_p6a2c1_llm_calls_contract.sql"
task_container="st-db-reorg-p6a2c1c-${RANDOM}-$$"
task_tmp="$(mktemp -d)"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$task_tmp"' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$("${admin_psql[@]}" -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT anon, authenticated, service_role TO app_admin;
CREATE SCHEMA experience; CREATE SCHEMA ops; CREATE SCHEMA billing; CREATE SCHEMA miniapp_analytics; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA experience, ops, billing, miniapp_analytics, test_fixture TO service_role;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, model text NOT NULL, session_id uuid, status text NOT NULL,
  llm_finish_reason text, llm_charge_id uuid, assistant_reply text, llm_billing_snapshot jsonb,
  llm_billing_settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id), delivery_attempt_id uuid);
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL REFERENCES experience.chat_generation_requests(chat_history_id),
  role text NOT NULL, provider text NOT NULL, provider_model_id text NOT NULL, generation_id text, UNIQUE (chat_history_id, role));
CREATE TABLE experience.openrouter_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_history_id uuid NOT NULL UNIQUE CONSTRAINT openrouter_chat_history_parent_fk REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  llm_generation_id text, llm_generation_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), provider_name text, finish_reason text, usage jsonb, usage_cache jsonb,
  native_tokens_cached integer, native_tokens_reasoning integer, native_tokens_completion integer,
  native_tokens_prompt integer, latency numeric, generation_time numeric, model text);
CREATE TABLE experience.venice_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_history_id uuid NOT NULL UNIQUE CONSTRAINT venice_chat_history_parent_fk REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  llm_provider_name text NOT NULL DEFAULT 'venice', llm_finish_reason text, llm_usage jsonb, llm_usage_cache jsonb,
  llm_native_tokens_cached integer, llm_native_tokens_reasoning integer, llm_native_tokens_completion integer,
  llm_native_tokens_prompt integer, llm_latency numeric, llm_generation_time numeric, llm_model text,
  llm_generation_id text, llm_generation_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON ALL TABLES IN SCHEMA experience TO service_role;
CREATE TABLE billing.llm_usage_charges (charge_key uuid PRIMARY KEY, model_id text, model_display_name text,
  status text NOT NULL, charged_amount numeric, usage_cost_usd numeric);
CREATE TABLE billing.payment_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text,
  amount_cents bigint, paid_at timestamptz);
CREATE TABLE miniapp_analytics.grafana_core_daily (metric_date date NOT NULL, metric_scope text NOT NULL,
  model_id text NOT NULL, model_name text, requests bigint, chat_users bigint, charged_requests bigint, charged_stars numeric,
  known_cost_requests bigint, recorded_cost_usd numeric, refreshed_at timestamptz, paid_orders bigint, paying_users bigint,
  cash_cny numeric, PRIMARY KEY (metric_date, metric_scope, model_id));
CREATE TABLE test_fixture.surplus_calls (history_id uuid, patch jsonb);
GRANT INSERT ON test_fixture.surplus_calls TO service_role;
CREATE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p_patch jsonb) RETURNS void
LANGUAGE sql AS $$ INSERT INTO test_fixture.surplus_calls VALUES (p_history_id, p_patch) $$;
GRANT EXECUTE ON FUNCTION experience.record_surplusintelligence_call(uuid, jsonb) TO service_role;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
SET check_function_bodies = off;
CREATE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid, p_attempt_id uuid, p_generation_id text) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fx$
DECLARE h experience.chat_history%ROWTYPE; r experience.chat_generation_requests%ROWTYPE; a experience.chat_generation_attempts%ROWTYPE; v_existing text;
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
  IF a.provider='openrouter' THEN
    IF EXISTS(SELECT 1 FROM experience.venice_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;
    SELECT llm_generation_id INTO v_existing FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id;
    IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM COALESCE(p_generation_id,a.generation_id) THEN RAISE EXCEPTION 'Provider identity conflict'; END IF;
    INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_id)
    VALUES(p_history_id,COALESCE(p_generation_id,a.generation_id)) ON CONFLICT(chat_history_id)
    DO UPDATE SET llm_generation_id=COALESCE(experience.openrouter_chat_history.llm_generation_id,EXCLUDED.llm_generation_id);
  ELSIF a.provider='surplus' THEN
    -- Losing Surplus attempts may coexist with an OpenRouter winner; only this RPC
    -- chooses billing/delivery ownership. The call table never changes the parent.
    PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));
  ELSIF a.provider='venice' THEN
    IF EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;
    SELECT llm_generation_id INTO v_existing FROM experience.venice_chat_history WHERE chat_history_id=p_history_id;
    IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM COALESCE(p_generation_id,a.generation_id) THEN RAISE EXCEPTION 'Provider identity conflict'; END IF;
    INSERT INTO experience.venice_chat_history(chat_history_id,llm_generation_id)
    VALUES(p_history_id,COALESCE(p_generation_id,a.generation_id)) ON CONFLICT(chat_history_id)
    DO UPDATE SET llm_generation_id=COALESCE(experience.venice_chat_history.llm_generation_id,EXCLUDED.llm_generation_id);
  ELSE
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
  END IF;
  -- The entire quote stays intact; only these two routing fields are bound to delivery.
  UPDATE experience.chat_history SET llm_billing_snapshot=llm_billing_snapshot || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id) WHERE id=p_history_id;
  UPDATE experience.chat_generation_attempts SET generation_id=COALESCE(generation_id,p_generation_id) WHERE id=p_attempt_id;
  UPDATE experience.chat_generation_requests SET delivery_attempt_id=p_attempt_id WHERE chat_history_id=p_history_id;
END;
$fx$;
CREATE FUNCTION miniapp_analytics.refresh_grafana_core_day(p_day date) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $fx$
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
  ), day_openrouter AS MATERIALIZED (
    -- 明细行在聊天记录之后写入；窗口两端各留余量，按 created_at 索引取一段再哈希配对。
    SELECT chat_history_id,usage FROM experience.openrouter_chat_history
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
  ), day_venice AS MATERIALIZED (
    SELECT chat_history_id,llm_usage FROM experience.venice_chat_history
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
  ), facts AS MATERIALIZED (
    SELECT h.user_id,
      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(c.model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(c.model_display_name,''),NULLIF(h.model,''),'unknown') AS model_name,
      CASE WHEN c.status IN ('charged','partial','reconciled','historical')
        THEN GREATEST(COALESCE(c.charged_amount,0),0) ELSE 0 END AS stars,
      COALESCE(c.usage_cost_usd,
        CASE WHEN jsonb_typeof(o.usage)='number' THEN (o.usage#>>'{}')::numeric END,
        CASE WHEN jsonb_typeof(v.llm_usage)='number' THEN (v.llm_usage#>>'{}')::numeric/1000000 END) AS cost_usd
    FROM day_history h
    LEFT JOIN billing.llm_usage_charges c ON c.charge_key=h.llm_charge_id
    LEFT JOIN day_openrouter o ON o.chat_history_id=h.id
    LEFT JOIN day_venice v ON v.chat_history_id=h.id
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
$fx$;
GRANT EXECUTE ON FUNCTION experience.select_chat_generation_delivery(uuid, uuid, text) TO service_role;
SQL

check "fixture functions are the production bodies" <<'SQL'
SELECT bool_and(md5(p.prosrc) = e.m) AND count(*) = 2 FROM (VALUES
  ('experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure, '574608264b75db1a5cdec2376f7ca204'),
  ('miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure, 'fda21fafbb0335a12f78fdb4227ba1ba')
) e(fn, m) JOIN pg_proc p ON p.oid = e.fn;
SQL

# Seed: settled turns three days ago (inside the self-check window) and fresh streaming turns for delivery.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION test_fixture.id(p_kind text, p_tag text) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $$ SELECT md5(p_kind || ':' || p_tag)::uuid $$;
GRANT EXECUTE ON FUNCTION test_fixture.id(text, text) TO service_role;
CREATE FUNCTION test_fixture.turn(p_tag text, p_age interval, p_status text, p_provider text, p_generation text,
  p_model text DEFAULT 'paid-m') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO experience.chat_history(id, user_id, model, status, llm_charge_id, llm_billing_snapshot, created_at)
  VALUES (test_fixture.id('h', p_tag), md5('u' || p_tag)::uuid, p_model, p_status, test_fixture.id('c', p_tag),
    jsonb_build_object('charge_id', test_fixture.id('c', p_tag), 'model_id', p_model, 'model_display_name', upper(p_model)),
    now() - p_age);
  INSERT INTO experience.chat_generation_requests(chat_history_id) VALUES (test_fixture.id('h', p_tag));
  IF p_provider IS NOT NULL THEN
    INSERT INTO experience.chat_generation_attempts VALUES (test_fixture.id('a', p_tag), test_fixture.id('h', p_tag),
      'primary', p_provider, p_provider || '/m', p_generation);
    IF p_status <> 'streaming' THEN
      UPDATE experience.chat_generation_requests SET delivery_attempt_id = test_fixture.id('a', p_tag)
      WHERE chat_history_id = test_fixture.id('h', p_tag);
    END IF;
  END IF;
END $$;
SELECT test_fixture.turn('old_or', '3 days', 'success', 'openrouter', 'g-old-or');
SELECT test_fixture.turn('old_ve', '3 days 10 minutes', 'success', 'venice', 'g-old-ve', 'venice-m');
SELECT test_fixture.turn('old_legacy', '3 days 20 minutes', 'success', NULL, NULL);
SELECT test_fixture.turn('old_none', '3 days 30 minutes', 'success', 'openrouter', NULL);
SELECT test_fixture.turn('old_bad', '3 days 40 minutes', 'success', 'openrouter', 'g-old-bad');
SELECT test_fixture.turn('recent_or', '2 hours', 'success', 'openrouter', 'g-recent');
SELECT test_fixture.turn('recent_new', '1 hour', 'success', 'openrouter', 'g-recent-new');
INSERT INTO experience.openrouter_chat_history(chat_history_id, llm_generation_id, usage, latency, generation_time,
  finish_reason, llm_generation_data, created_at, updated_at) VALUES
  (test_fixture.id('h','old_or'), 'g-old-or', '0.25', 100, 200, 'stop', '{"id":1}', now() - interval '3 days', now() - interval '3 days'),
  (test_fixture.id('h','old_legacy'), 'g-legacy', '0.5', 1, 2, 'stop', '{"id":2}', now() - interval '3 days 20 minutes', now() - interval '3 days 20 minutes'),
  (test_fixture.id('h','old_bad'), 'g-old-bad', '0.75', 1, 2, 'stop', '{"id":3}', now() - interval '3 days 40 minutes', now() - interval '3 days 40 minutes'),
  (test_fixture.id('h','recent_or'), 'g-recent', NULL, NULL, NULL, NULL, NULL, now() - interval '2 hours', now() - interval '2 hours');
INSERT INTO experience.venice_chat_history(chat_history_id, llm_generation_id, llm_usage, llm_latency, created_at, updated_at)
VALUES (test_fixture.id('h','old_ve'), 'g-old-ve', '3000', 9, now() - interval '3 days 10 minutes', now() - interval '3 days 10 minutes');
INSERT INTO billing.llm_usage_charges VALUES (test_fixture.id('c','old_or'), 'paid-m', 'PAID-M', 'charged', 5, NULL);
SQL

"${admin_psql[@]}" <"$expand" >"$task_tmp/expand.log" 2>&1 || { cat "$task_tmp/expand.log"; echo "FAIL: expand"; exit 1; }
echo "ok: expand applied as the starting shape"

# The old backend keeps writing detail rows until its release; the new backend writes ops directly.
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.openrouter_chat_history SET usage = '0.4', latency = 7, generation_time = 8, finish_reason = 'stop',
  llm_generation_data = '{"late":true}', updated_at = now() WHERE chat_history_id = test_fixture.id('h', 'recent_or');
INSERT INTO experience.openrouter_chat_history(chat_history_id, llm_generation_id, created_at, updated_at)
VALUES (test_fixture.id('h','recent_new'), 'g-recent-new', now(), now());
SELECT experience.record_llm_call_metadata(test_fixture.id('h','recent_new'), 'g-recent-new', '{"usage":0.5,"latency":3}');
-- Grafana rows for the settled day, computed by the old function.
SELECT miniapp_analytics.refresh_grafana_core_day(((now() - interval '3 days') AT TIME ZONE 'Asia/Shanghai')::date);
CREATE TABLE test_fixture.daily_before AS SELECT metric_date, metric_scope, model_id, model_name, requests, chat_users,
  charged_requests, charged_stars, known_cost_requests, recorded_cost_usd FROM miniapp_analytics.grafana_core_daily;
-- Break one settled turn's cost in ops so phase 2 must refuse.
UPDATE ops.llm_calls SET cost_usd = 9 WHERE generation_id = 'g-old-bad';
SQL
check "before: Grafana sees OpenRouter + Venice costs for the settled day" <<'SQL'
SELECT recorded_cost_usd = 0.25 + 0.003 + 0.5 + 0.75 AND known_cost_requests = 4
FROM test_fixture.daily_before WHERE metric_scope = 'overall';
SQL

if "${admin_psql[@]}" <"$contract" >"$task_tmp/run1.log" 2>&1; then echo "FAIL: contract accepted a cost mismatch"; exit 1; fi
grep -q 'p6a2c1c: 1 of 5 settled turns would report a different cost from ops.llm_calls' "$task_tmp/run1.log" ||
  { cat "$task_tmp/run1.log"; exit 1; }
echo "ok: phase 2 refuses a settled-turn cost mismatch"
check "after the refused run: phase 1 committed, tables and ops untouched by phase 2" <<'SQL'
SELECT to_regclass('experience.openrouter_chat_history') IS NOT NULL
  AND to_regclass('experience.venice_chat_history') IS NOT NULL
  AND (SELECT prosrc !~ '(openrouter|venice)_chat_history' FROM pg_proc WHERE oid = 'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure)
  AND (SELECT prosrc ~ 'ops\.llm_calls' AND prosrc !~ '(openrouter|venice)_chat_history' FROM pg_proc WHERE oid = 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure)
  AND (SELECT cost_usd IS NULL FROM ops.llm_calls WHERE generation_id = 'g-recent');
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE ops.llm_calls SET cost_usd = 0.75 WHERE generation_id = 'g-old-bad';
SQL
"${admin_psql[@]}" <"$contract" >"$task_tmp/run2.log" 2>&1 || { cat "$task_tmp/run2.log"; exit 1; }
grep -q 'p6a2c1c: select_chat_generation_delivery already patched' "$task_tmp/run2.log" &&
  grep -q 'p6a2c1c: refresh_grafana_core_day already patched' "$task_tmp/run2.log" &&
  grep -q 'p6a2c1c: delta copied openrouter 2 / venice 0, 5 settled turns cost-identical, detail tables dropped' "$task_tmp/run2.log" ||
  { cat "$task_tmp/run2.log"; echo "FAIL: unexpected rerun notices"; exit 1; }
echo "ok: rerun skips phase 1 and finishes phase 2"

check "delta copy: an old-backend write fills ops, a newer ops value is kept, tables are gone" <<'SQL'
SELECT (SELECT cost_usd = 0.4 AND latency_ms = 7 AND raw_usage = '{"late":true}' FROM ops.llm_calls WHERE generation_id = 'g-recent')
  AND (SELECT cost_usd = 0.5 AND latency_ms = 3 FROM ops.llm_calls WHERE generation_id = 'g-recent-new')
  AND to_regclass('experience.openrouter_chat_history') IS NULL AND to_regclass('experience.venice_chat_history') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosrc ~ '(openrouter|venice)_chat_history');
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
SELECT miniapp_analytics.refresh_grafana_core_day(((now() - interval '3 days') AT TIME ZONE 'Asia/Shanghai')::date);
SQL
check "Grafana daily rows for the settled day are identical when read from ops.llm_calls" <<'SQL'
WITH now_rows AS (SELECT metric_date, metric_scope, model_id, model_name, requests, chat_users, charged_requests,
  charged_stars, known_cost_requests, recorded_cost_usd FROM miniapp_analytics.grafana_core_daily)
SELECT (SELECT count(*) FROM test_fixture.daily_before) >= 3
  AND NOT EXISTS (SELECT * FROM now_rows EXCEPT SELECT * FROM test_fixture.daily_before)
  AND NOT EXISTS (SELECT * FROM test_fixture.daily_before EXCEPT SELECT * FROM now_rows);
SQL

# Delivery after the contract: identity bound to attempts only, no detail tables.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.delivery (tag text PRIMARY KEY, sqlstate text);
GRANT INSERT ON test_fixture.delivery TO service_role;
CREATE FUNCTION test_fixture.try_deliver(p_label text, p_tag text, p_attempt_tag text, p_generation text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM experience.select_chat_generation_delivery(test_fixture.id('h', p_tag), test_fixture.id('a', p_attempt_tag), p_generation);
    INSERT INTO test_fixture.delivery VALUES (p_label, 'ok');
  EXCEPTION WHEN OTHERS THEN INSERT INTO test_fixture.delivery VALUES (p_label, SQLSTATE);
  END;
END $$;
GRANT EXECUTE ON FUNCTION test_fixture.try_deliver(text, text, text, text) TO service_role;
SELECT test_fixture.turn('d_or', '1 minute', 'streaming', 'openrouter', NULL);
SELECT test_fixture.turn('d_ve', '1 minute', 'streaming', 'venice', 'g-dve');
SELECT test_fixture.turn('d_sp', '1 minute', 'streaming', 'surplus', 'g-dsp');
SELECT test_fixture.turn('d_xx', '1 minute', 'streaming', 'mystery', 'g-dxx');
INSERT INTO experience.chat_generation_attempts VALUES (test_fixture.id('a', 'd_or2'), test_fixture.id('h', 'd_or'),
  'fallback', 'openrouter', 'openrouter/f', NULL);
SET ROLE service_role;
SELECT test_fixture.try_deliver('or', 'd_or', 'd_or', 'g-dor');
SELECT test_fixture.try_deliver('or_repeat', 'd_or', 'd_or', 'g-dor');
SELECT test_fixture.try_deliver('or_competing', 'd_or', 'd_or2', 'g-other');
SELECT test_fixture.try_deliver('venice', 'd_ve', 'd_ve', 'g-dve');
SELECT test_fixture.try_deliver('surplus', 'd_sp', 'd_sp', NULL);
SELECT test_fixture.try_deliver('unknown', 'd_xx', 'd_xx', NULL);
RESET ROLE;
SQL
check "delivery: binds the attempt, records Surplus, refuses a competing winner and unknown providers" <<'SQL'
SELECT (SELECT jsonb_object_agg(tag, sqlstate) FROM test_fixture.delivery) = '{"or":"ok","or_repeat":"ok",
    "or_competing":"PT409","venice":"ok","surplus":"ok","unknown":"22023"}'::jsonb
  AND (SELECT delivery_attempt_id = test_fixture.id('a','d_or') FROM experience.chat_generation_requests WHERE chat_history_id = test_fixture.id('h','d_or'))
  AND (SELECT generation_id = 'g-dor' FROM experience.chat_generation_attempts WHERE id = test_fixture.id('a','d_or'))
  AND (SELECT llm_billing_snapshot ->> 'provider' = 'venice' FROM experience.chat_history WHERE id = test_fixture.id('h','d_ve'))
  AND (SELECT count(*) = 1 AND bool_and(patch = '{"generation_id":"g-dsp"}') FROM test_fixture.surplus_calls)
  AND (SELECT delivery_attempt_id IS NULL FROM experience.chat_generation_requests WHERE chat_history_id = test_fixture.id('h','d_xx'));
SQL

"${admin_psql[@]}" <"$contract" >"$task_tmp/run3.log" 2>&1 || { cat "$task_tmp/run3.log"; exit 1; }
grep -q 'p6a2c1c: provider detail tables already dropped' "$task_tmp/run3.log" || { cat "$task_tmp/run3.log"; exit 1; }
echo "ok: a further rerun changes nothing"
"${admin_psql[@]}" -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid IN ('experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure, 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure) ORDER BY oid" >"$task_tmp/md5.txt"
echo "info: patched md5s = $(tr '\n' ' ' <"$task_tmp/md5.txt")"
echo "PASS: p6a2c1 llm_calls contract"
