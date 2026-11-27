#!/usr/bin/env bash
# Disposable PG17 only (--network none). No remote URI, host ports or real user data.
#
# 20261127_chat_cost_rollups.sql 与随后的 20261127_chat_cost_drop_prices.sql 的本地验证（迁移用非超级用户 app_admin 执行）：
#   - 生产形状夹具：ops.llm_calls、experience.chat_history、analytics.llm_call_costs / llm_turn_costs（2026-11-27 生产原文）；
#   - 有 pg_cron（生产，模拟托管表只读 + schedule 入口）/ 没有（TEST）两种库都能执行，重跑不变，定时任务各一个；
#   - 每轮成本结构：首发胜出 / 首发落败与取消 / 兜底 / 重写；待补、补不到、估算分开计；中转渠道无美元不当 0；
#   - 与 llm_turn_costs 逐轮 total 一致；跨刷新起点的轮不截断；重跑幂等；
#   - 小时单价只算真实账单（排除估算、补不到、待补、无 token）；
#   - 31 天守卫、建议锁、180 天清理；reader 只读表、不能执行函数，anon 读不到；
#   - 成本视图缺列时守卫拒绝且整体回滚；部分索引能被视图的时间过滤用上。
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
migration="$repo_root/packages/shared/migrations/20261127_chat_cost_rollups.sql"
pg="chat-cost-pg-$$"
out_dir=$(mktemp -d)
trap 'docker rm -f "$pg" >/dev/null 2>&1 || true; rm -rf "$out_dir"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

docker run --rm -d --network none --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
su_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
app_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U app_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }
q() { local db=$1; shift; app_psql "$db" -At -c "$*"; }

su_psql postgres >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN CREATEROLE;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE ROLE grafana_cloud LOGIN IN ROLE first_token_metrics_reader;
GRANT service_role, anon, first_token_metrics_reader TO app_admin;
SQL

# fixture <db> <cron|nocron> [broken]
fixture() {
  local db=$1 with_cron=$2 broken=${3:-}
  su_psql postgres -c "CREATE DATABASE $db OWNER app_admin" >/dev/null
  if [[ "$with_cron" == cron ]]; then
    su_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text NOT NULL, command text NOT NULL,
  username text NOT NULL DEFAULT current_user, active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS
  $$ INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid $$;
GRANT USAGE ON SCHEMA cron TO app_admin;
GRANT SELECT ON cron.job TO app_admin;
GRANT EXECUTE ON FUNCTION cron.schedule(text, text, text) TO app_admin;
SQL
  fi
  local prompt_col='l.prompt_tokens,'
  [[ "$broken" == broken ]] && prompt_col=''
  app_psql "$db" >/dev/null <<SQL
CREATE SCHEMA ops; CREATE SCHEMA analytics; CREATE SCHEMA experience;
GRANT USAGE ON SCHEMA analytics TO first_token_metrics_reader, service_role, anon;
CREATE TABLE experience.chat_history(id uuid PRIMARY KEY, model text);
CREATE TABLE ops.llm_calls(
  id uuid PRIMARY KEY, attempt_id uuid, chat_history_id uuid, provider text NOT NULL,
  generation_id text, request_id text, model text, http_status integer, prompt_tokens bigint,
  completion_tokens bigint, cost_usd numeric, cost_source text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  lane text NOT NULL, role text, slot smallint, candidate_id text, dispatched_at timestamptz, end_reason text,
  panel_trigger text);
-- 2026-11-27 生产原文（pg_get_viewdef）
CREATE VIEW analytics.llm_call_costs AS
 SELECT l.id, l.chat_history_id, l.lane,
    CASE WHEN l.lane = 'free_zone'::text THEN l.candidate_id ELSE h.model END AS model_id,
    l.role, l.slot, l.provider, l.model AS provider_model, l.dispatched_at, l.end_reason,
    l.end_reason = 'first_token_observed'::text AS won, l.cost_source,
    l.cost_source IS NULL OR (l.provider = ANY (ARRAY['packy'::text, 'onexmodel'::text])) AND l.cost_usd IS NULL AS cost_pending,
    l.cost_source = 'estimated'::text AS cost_estimated,
    CASE WHEN l.cost_source IS NOT NULL THEN
      CASE WHEN l.provider = ANY (ARRAY['packy'::text, 'onexmodel'::text]) THEN l.cost_usd ELSE COALESCE(l.cost_usd, 0::numeric) END
    ELSE NULL::numeric END AS cost_usd,
    ${prompt_col}
    l.completion_tokens
   FROM ops.llm_calls l LEFT JOIN experience.chat_history h ON h.id = l.chat_history_id
  WHERE l.dispatched_at IS NOT NULL AND (l.lane = ANY (ARRAY['chat'::text, 'free_zone'::text]));
SQL
  [[ "$broken" == broken ]] && return 0
  app_psql "$db" >/dev/null <<'SQL'
CREATE VIEW analytics.llm_turn_costs AS
 SELECT chat_history_id, lane, model_id, min(dispatched_at) AS turn_at,
    count(*) FILTER (WHERE role = 'primary'::text) AS primary_calls,
    count(*) FILTER (WHERE role = 'fallback'::text) AS fallback_calls,
    COALESCE(sum(cost_usd) FILTER (WHERE role = 'primary'::text), 0::numeric) AS primary_cost_usd,
    COALESCE(sum(cost_usd) FILTER (WHERE role = 'fallback'::text), 0::numeric) AS fallback_cost_usd,
    COALESCE(sum(cost_usd), 0::numeric) AS total_cost_usd,
    COALESCE(sum(cost_usd) FILTER (WHERE cost_estimated), 0::numeric) AS estimated_cost_usd,
    bool_or(cost_pending) AS cost_pending
   FROM analytics.llm_call_costs GROUP BY chat_history_id, lane, model_id;
GRANT SELECT ON analytics.llm_call_costs, analytics.llm_turn_costs TO service_role, first_token_metrics_reader;

-- 场景（时间相对「三小时前的整点」base）
CREATE TEMP TABLE b AS SELECT date_trunc('hour', now()) - interval '3 hours' AS base;
INSERT INTO experience.chat_history VALUES
  ('a0000000-0000-4000-8000-00000000000a', 'model-a'),
  ('a0000000-0000-4000-8000-00000000000c', 'model-relay'),
  ('a0000000-0000-4000-8000-00000000000d', 'model-a'),
  ('a0000000-0000-4000-8000-00000000000e', 'model-a');
INSERT INTO ops.llm_calls(id, chat_history_id, provider, model, lane, role, slot, candidate_id, dispatched_at,
                          end_reason, cost_source, cost_usd, prompt_tokens, completion_tokens)
SELECT v.id::uuid, v.turn::uuid, v.provider, v.model, v.lane, v.role, v.slot, v.cand, b.base + v.off,
       v.end_reason, v.src, v.cost, v.pt, v.ct
  FROM b, (VALUES
  -- A 付费：首发胜出 + 兜底落败（取消）+ 出字后重写
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'openrouter', 'or/model-a', 'chat', 'primary', 0, NULL, interval '10 minutes', 'first_token_observed', 'openrouter_generation', 0.01, 1000, 200),
  ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-00000000000a', 'openrouter', 'or/fallback', 'chat', 'fallback', 0, NULL, interval '10 minutes 4 seconds', 'cancelled', 'openrouter_generation', 0.002, 500, 0),
  ('10000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-00000000000a', 'openrouter', 'or/fallback', 'chat', 'rewrite', 0, NULL, interval '10 minutes 30 seconds', 'completed', 'openrouter_generation', 0.005, 1000, 300),
  -- B 畅聊：并发两路（一路胜出、一路取消补不到）+ 兜底待补
  ('10000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-00000000000b', 'surplus', 'gemini-3-flash-preview', 'free_zone', 'primary', 0, 'free-x', interval '20 minutes', 'first_token_observed', 'surplus_request_record', 0.0004, 8000, 400),
  ('10000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-00000000000b', 'surplus', 'gemini-3-flash-preview', 'free_zone', 'primary', 1, 'free-x', interval '20 minutes', 'cancelled', 'unavailable', NULL, NULL, NULL),
  ('10000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-00000000000b', 'surplus', 'deepseek-v4.1-flash-1017', 'free_zone', 'fallback', 0, 'free-x', interval '20 minutes 7 seconds', 'first_token_deadline', NULL, NULL, NULL, NULL),
  ('10000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'surplus', 'gemini-3-flash-preview', 'free_zone', 'primary', 2, 'free-x', interval '20 minutes', 'upstream_error', 'unavailable', NULL, NULL, NULL),
  -- C 中转渠道：有账单来源但没有美元换算 → 待补，不当 0
  ('10000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-00000000000c', 'packy', 'relay/m', 'chat', 'primary', 0, NULL, interval '30 minutes', 'first_token_observed', 'relay_invoice', NULL, 900, 100),
  -- D 估算：首发取消，按输入 token 粗估
  ('10000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-00000000000d', 'openrouter', 'or/model-a', 'chat', 'primary', 0, NULL, interval '40 minutes', 'cancelled', 'estimated', 0.003, 3000, 0),
  -- E 跨在 base 前后（首个调用在 base 前 1 分钟）
  ('10000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-00000000000e', 'openrouter', 'or/model-a', 'chat', 'primary', 0, NULL, interval '-1 minute', 'first_token_deadline', 'openrouter_generation', 0.001, 800, 0),
  ('10000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000e', 'openrouter', 'or/fallback', 'chat', 'fallback', 0, NULL, interval '20 seconds', 'first_token_observed', 'openrouter_generation', 0.004, 800, 250)
  ) AS v(id, turn, provider, model, lane, role, slot, cand, off, end_reason, src, cost, pt, ct);
UPDATE ops.llm_calls SET http_status = 404 WHERE id = '10000000-0000-4000-8000-00000000000b';
UPDATE ops.llm_calls SET http_status = 200 WHERE http_status IS NULL AND id <> '10000000-0000-4000-8000-000000000005';
-- 面板 lane 不属于聊天，不能进来
INSERT INTO ops.llm_calls(id, provider, lane, role, dispatched_at, cost_source, cost_usd, panel_trigger)
  SELECT '20000000-0000-4000-8000-000000000001', 'surplus', 'status_bar', 'primary', base + interval '15 minutes', 'surplus_request_record', 0.5, 'auto' FROM b;
SQL
}

fixture prod_db cron
fixture test_db nocron
fixture broken_db cron broken

echo "== migrate (pg_cron present, as production) and rerun"
app_psql prod_db -f - <"$migration" >"$out_dir/prod.log" 2>&1 || { cat "$out_dir/prod.log"; fail 'migration failed'; }
snap1=$(q prod_db "SELECT string_agg(concat_ws('|', chat_history_id, turn_at, lane, model_id, calls, total_cost_usd, known_calls, pending_calls, unavailable_calls), ',' ORDER BY chat_history_id) FROM analytics.chat_turn_costs")
app_psql prod_db -f - <"$migration" >"$out_dir/prod2.log" 2>&1 || { cat "$out_dir/prod2.log"; fail 'rerun failed'; }
[[ "$(q prod_db "SELECT count(*) || '|' || string_agg(jobname || '@' || schedule, ',' ORDER BY jobname) FROM cron.job")" == \
   "2|chat_costs_recent_15m@4,19,34,49 * * * *,chat_costs_week_daily@23 20 * * *" ]] || fail 'cron jobs'
q prod_db "SELECT command FROM cron.job WHERE jobname = 'chat_costs_recent_15m'" | grep -q "statement_timeout = '10s'.*refresh_chat_costs(now() - interval '26 hours')" || fail 'recent job command'
q prod_db "SELECT command FROM cron.job WHERE jobname = 'chat_costs_week_daily'" | grep -q "statement_timeout = '60s'.*refresh_chat_costs(now() - interval '8 days')" || fail 'daily job command'
pass 'pg_cron jobs scheduled once, rerun keeps them'
snap2=$(q prod_db "SELECT string_agg(concat_ws('|', chat_history_id, turn_at, lane, model_id, calls, total_cost_usd, known_calls, pending_calls, unavailable_calls), ',' ORDER BY chat_history_id) FROM analytics.chat_turn_costs")
[[ "$snap1" == "$snap2" ]] || fail 'rerun changed turn rows'
pass 'migration rerun is idempotent'

echo "== per-turn cost structure"
row() { q prod_db "SELECT concat_ws('|', lane, model_id, calls, primary_calls, fallback_calls, rewrite_calls, total_cost_usd::numeric(12,4), primary_won_cost_usd::numeric(12,4), primary_lost_cost_usd::numeric(12,4), fallback_cost_usd::numeric(12,4), rewrite_cost_usd::numeric(12,4), estimated_cost_usd::numeric(12,4), known_calls, pending_calls, unavailable_calls, prompt_tokens, completion_tokens) FROM analytics.chat_turn_costs WHERE chat_history_id = '$1'"; }
[[ "$(row a0000000-0000-4000-8000-00000000000a)" == 'chat|model-a|3|1|1|1|0.0170|0.0100|0.0000|0.0020|0.0050|0.0000|3|0|0|2500|500' ]] || fail "turn A: $(row a0000000-0000-4000-8000-00000000000a)"
pass 'A: primary won + cancelled fallback + rewrite are all summed'
[[ "$(row b0000000-0000-4000-8000-00000000000b)" == 'free_zone|free-x|4|3|1|0|0.0004|0.0004|0.0000|0.0000|0.0000|0.0000|2|1|1|8000|400' ]] || fail "turn B: $(row b0000000-0000-4000-8000-00000000000b)"
pass 'B: free zone candidate id; cancelled slot unavailable, 404 slot known zero, fallback pending'
[[ "$(row a0000000-0000-4000-8000-00000000000c)" == 'chat|model-relay|1|1|0|0|0.0000|0.0000|0.0000|0.0000|0.0000|0.0000|0|1|0|900|100' ]] || fail "turn C: $(row a0000000-0000-4000-8000-00000000000c)"
pass 'C: relay call without USD conversion is pending, not a known zero'
[[ "$(row a0000000-0000-4000-8000-00000000000d)" == 'chat|model-a|1|1|0|0|0.0030|0.0000|0.0030|0.0000|0.0000|0.0030|1|0|0|3000|0' ]] || fail "turn D: $(row a0000000-0000-4000-8000-00000000000d)"
pass 'D: cancelled primary estimate lands in primary_lost and estimated'
[[ "$(q prod_db "SELECT count(*) FROM analytics.chat_turn_costs")" == 5 ]] || fail 'panel lane or extra turns leaked in'
pass 'status_bar calls stay out'

[[ "$(q prod_db "SELECT count(*) FROM analytics.chat_turn_costs t JOIN analytics.llm_turn_costs v USING (chat_history_id) WHERE t.total_cost_usd = v.total_cost_usd AND t.turn_at = v.turn_at AND t.model_id = v.model_id")" == 5 ]] || fail 'totals differ from llm_turn_costs'
pass 'every turn total equals analytics.llm_turn_costs'

echo "== boundary: a turn straddling p_since is not truncated"
q prod_db "DELETE FROM analytics.chat_turn_costs WHERE chat_history_id = 'a0000000-0000-4000-8000-00000000000e'" >/dev/null
[[ "$(q prod_db "SELECT analytics.refresh_chat_costs(date_trunc('hour', now()) - interval '3 hours')")" == t ]] || fail 'refresh(base)'
[[ "$(q prod_db "SELECT count(*) FROM analytics.chat_turn_costs WHERE chat_history_id = 'a0000000-0000-4000-8000-00000000000e'")" == 0 ]] || fail 'partial turn E written'
[[ "$(q prod_db "SELECT analytics.refresh_chat_costs(date_trunc('hour', now()) - interval '4 hours')")" == t ]] || fail 'refresh(base-1h)'
[[ "$(row a0000000-0000-4000-8000-00000000000e)" == 'chat|model-a|2|1|1|0|0.0050|0.0000|0.0010|0.0040|0.0000|0.0000|2|0|0|1600|250' ]] || fail "turn E: $(row a0000000-0000-4000-8000-00000000000e)"
pass 'E skipped when it starts before p_since, complete from an earlier p_since'

echo "== late cost arrives and refresh picks it up"
q prod_db "UPDATE ops.llm_calls SET cost_source = 'surplus_request_record', cost_usd = 0.0002, prompt_tokens = 8000, completion_tokens = 300 WHERE id = '10000000-0000-4000-8000-000000000006'" >/dev/null
[[ "$(q prod_db "SELECT analytics.refresh_chat_costs(now() - interval '26 hours')")" == t ]] || fail 'refresh 26h'
[[ "$(row b0000000-0000-4000-8000-00000000000b)" == 'free_zone|free-x|4|3|1|0|0.0006|0.0004|0.0000|0.0002|0.0000|0.0000|3|0|1|16000|700' ]] || fail "turn B after late cost: $(row b0000000-0000-4000-8000-00000000000b)"
pass 'late Surplus fallback cost replaces pending'

echo "== hourly prices use real invoices only"
prices=$(q prod_db "SELECT string_agg(concat_ws('|', lane, role, provider, provider_model, calls, priced_calls, cost_usd::numeric(12,4), prompt_tokens, completion_tokens), ',' ORDER BY lane, role, provider, provider_model, hour_at) FROM analytics.chat_model_prices_hourly")
expected='chat|fallback|openrouter|or/fallback|2|2|0.0060|1300|250,chat|primary|openrouter|or/model-a|1|1|0.0010|800|0,chat|primary|openrouter|or/model-a|2|1|0.0100|1000|200,chat|primary|packy|relay/m|1|0|0.0000|0|0,chat|rewrite|openrouter|or/fallback|1|1|0.0050|1000|300,free_zone|fallback|surplus|deepseek-v4.1-flash-1017|1|1|0.0002|8000|300,free_zone|primary|surplus|gemini-3-flash-preview|3|1|0.0004|8000|400'
[[ "$prices" == "$expected" ]] || fail "prices: $prices"
pass 'estimated / unavailable / pending / relay-without-USD calls stay out of unit price'

echo "== idempotent refresh"
before=$(q prod_db "SELECT md5(string_agg(concat_ws('|', chat_history_id, total_cost_usd, primary_won_cost_usd, primary_lost_cost_usd, fallback_cost_usd, rewrite_cost_usd, known_calls, pending_calls, unavailable_calls), ',' ORDER BY chat_history_id)) FROM analytics.chat_turn_costs")
pbefore=$(q prod_db "SELECT md5(string_agg(concat_ws('|', hour_at, lane, role, provider, provider_model, calls, priced_calls, cost_usd), ',' ORDER BY hour_at, lane, role, provider, provider_model)) FROM analytics.chat_model_prices_hourly")
q prod_db "SELECT analytics.refresh_chat_costs(now() - interval '8 days'); SELECT analytics.refresh_chat_costs(now() - interval '8 days')" >/dev/null
[[ "$(q prod_db "SELECT md5(string_agg(concat_ws('|', chat_history_id, total_cost_usd, primary_won_cost_usd, primary_lost_cost_usd, fallback_cost_usd, rewrite_cost_usd, known_calls, pending_calls, unavailable_calls), ',' ORDER BY chat_history_id)) FROM analytics.chat_turn_costs")" == "$before" ]] || fail 'turn rows changed on rerun'
[[ "$(q prod_db "SELECT md5(string_agg(concat_ws('|', hour_at, lane, role, provider, provider_model, calls, priced_calls, cost_usd), ',' ORDER BY hour_at, lane, role, provider, provider_model)) FROM analytics.chat_model_prices_hourly")" == "$pbefore" ]] || fail 'price rows changed on rerun'
pass 'repeated refresh yields the same rows'

echo "== guards, lock, retention"
if q prod_db "SELECT analytics.refresh_chat_costs(now() - interval '40 days')" >"$out_dir/guard.log" 2>&1; then fail '40-day refresh accepted'; fi
grep -q 'within the last 31 days' "$out_dir/guard.log" || fail 'guard message'
pass 'p_since older than 31 days is rejected'
docker exec "$pg" psql -X -q -U app_admin -d prod_db -c "SELECT pg_advisory_lock(20261127, 30), pg_sleep(4)" >/dev/null 2>&1 &
locker=$!
sleep 1.5
[[ "$(q prod_db "SELECT analytics.refresh_chat_costs(now() - interval '1 hour')")" == f ]] || fail 'refresh ran while locked'
wait "$locker"
pass 'concurrent refresh returns false under the advisory lock'
q prod_db "INSERT INTO analytics.chat_turn_costs VALUES ('c0000000-0000-4000-8000-000000000001', now() - interval '200 days', 'chat', 'old', 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, now())" >/dev/null
q prod_db "INSERT INTO analytics.chat_model_prices_hourly VALUES (date_trunc('hour', now() - interval '200 days'), 'chat', 'primary', 'openrouter', 'old', 1, 1, 1, 1, 1, now())" >/dev/null
q prod_db "SELECT analytics.refresh_chat_costs(now() - interval '1 hour')" >/dev/null
[[ "$(q prod_db "SELECT (SELECT count(*) FROM analytics.chat_turn_costs WHERE model_id = 'old') + (SELECT count(*) FROM analytics.chat_model_prices_hourly WHERE provider_model = 'old')")" == 0 ]] || fail 'retention'
pass 'rows older than 180 days are deleted'

echo "== privileges"
reader() { docker exec -i "$pg" psql -X -q -U grafana_cloud -d prod_db -v ON_ERROR_STOP=1 -At -c "$*"; }
[[ "$(reader "SELECT (SELECT count(*) FROM analytics.chat_turn_costs) > 0 AND (SELECT count(*) FROM analytics.chat_model_prices_hourly) > 0")" == t ]] || fail 'reader cannot read'
if reader "SELECT analytics.refresh_chat_costs(now() - interval '1 hour')" >/dev/null 2>&1; then fail 'reader executed refresh'; fi
[[ "$(q prod_db "SELECT has_table_privilege('anon', 'analytics.chat_turn_costs', 'SELECT') OR has_function_privilege('service_role', 'analytics.refresh_chat_costs(timestamptz)', 'EXECUTE') OR has_function_privilege('anon', 'analytics.refresh_chat_costs(timestamptz)', 'EXECUTE')")" == f ]] || fail 'anon/service privileges'
[[ "$(q prod_db "SELECT relrowsecurity FROM pg_class WHERE oid IN ('analytics.chat_turn_costs'::regclass, 'analytics.chat_model_prices_hourly'::regclass) GROUP BY 1")" == t ]] || fail 'RLS'
pass 'reader reads only; anon / service_role cannot execute; RLS on'

echo "== partial index serves the view's time filter"
plan=$(app_psql prod_db -At <<'SQL'
SET enable_seqscan = off;
EXPLAIN SELECT * FROM analytics.llm_call_costs WHERE dispatched_at >= now() - interval '26 hours';
SQL
)
grep -q 'llm_calls_chat_dispatched_idx' <<<"$plan" || { echo "$plan"; fail 'partial index not usable'; }
pass 'llm_calls_chat_dispatched_idx matches the view lane predicate'

echo "== TEST shape (no pg_cron)"
app_psql test_db -f - <"$migration" >"$out_dir/test.log" 2>&1 || { cat "$out_dir/test.log"; fail 'migration without pg_cron failed'; }
grep -q 'pg_cron unavailable' "$out_dir/test.log" || fail 'missing NOTICE without pg_cron'
[[ "$(q test_db "SELECT count(*) FROM analytics.chat_turn_costs")" == 5 ]] || fail 'backfill without pg_cron'
app_psql test_db -f - <"$migration" >/dev/null 2>&1 || fail 'rerun without pg_cron failed'
pass 'TEST shape: tables, function and backfill without a schedule'

echo "== guard rejects an unexpected cost view and rolls back"
if app_psql broken_db -f - <"$migration" >"$out_dir/broken.log" 2>&1; then fail 'broken view accepted'; fi
grep -q 'llm_call_costs lacks prompt_tokens' "$out_dir/broken.log" || { cat "$out_dir/broken.log"; fail 'guard message'; }
[[ "$(q broken_db "SELECT (to_regclass('analytics.chat_turn_costs') IS NULL) AND (to_regprocedure('analytics.refresh_chat_costs(timestamptz)') IS NULL) AND NOT EXISTS (SELECT 1 FROM cron.job)")" == t ]] || fail 'broken migration left objects'
pass 'guard failure leaves no tables, function or cron job'

echo "== 20261127_chat_cost_drop_prices.sql (after the rollups migration)"
migration2="$repo_root/packages/shared/migrations/20261127_chat_cost_drop_prices.sql"
turns_md5() { q "$1" "SELECT md5(string_agg(concat_ws('|', chat_history_id, turn_at, lane, model_id, calls, total_cost_usd, primary_won_cost_usd, primary_lost_cost_usd, fallback_cost_usd, rewrite_cost_usd, estimated_cost_usd, known_calls, pending_calls, unavailable_calls, prompt_tokens, completion_tokens), ',' ORDER BY chat_history_id)) FROM analytics.chat_turn_costs"; }
before=$(turns_md5 prod_db)
app_psql prod_db -f - <"$migration2" >"$out_dir/drop.log" 2>&1 || { cat "$out_dir/drop.log"; fail 'drop migration failed'; }
app_psql prod_db -f - <"$migration2" >"$out_dir/drop2.log" 2>&1 || { cat "$out_dir/drop2.log"; fail 'drop migration rerun failed'; }
[[ "$(q prod_db "SELECT to_regclass('analytics.chat_model_prices_hourly') IS NULL")" == t ]] || fail 'prices table still there'
[[ "$(q prod_db "SELECT analytics.refresh_chat_costs(now() - interval '8 days')")" == t ]] || fail 'refresh after drop'
[[ "$(turns_md5 prod_db)" == "$before" ]] || fail 'turn rows changed after the drop migration'
[[ "$(q prod_db "SELECT count(*) FROM cron.job WHERE jobname IN ('chat_costs_recent_15m', 'chat_costs_week_daily')")" == 2 ]] || fail 'cron jobs changed'
if reader "SELECT analytics.refresh_chat_costs(now() - interval '1 hour')" >/dev/null 2>&1; then fail 'reader executed refresh after drop'; fi
[[ "$(reader "SELECT count(*) > 0 FROM analytics.chat_turn_costs")" == t ]] || fail 'reader lost turn costs'
pass 'prices table dropped; refresh still yields the same turn rows; cron and grants unchanged'
app_psql test_db -f - <"$migration2" >/dev/null 2>&1 || fail 'drop migration without pg_cron failed'
[[ "$(q test_db "SELECT to_regclass('analytics.chat_model_prices_hourly') IS NULL AND analytics.refresh_chat_costs(now() - interval '1 hour')")" == t ]] || fail 'TEST shape after drop'
pass 'TEST shape: drop migration works without pg_cron'
if app_psql broken_db -f - <"$migration2" >"$out_dir/drop-broken.log" 2>&1; then fail 'drop migration ran without the rollups migration'; fi
grep -q 'run 20261127_chat_cost_rollups.sql first' "$out_dir/drop-broken.log" || { cat "$out_dir/drop-broken.log"; fail 'drop guard message'; }
pass 'drop migration refuses to run before the rollups migration'

echo "PASS: 20261127_chat_cost_rollups.sql + 20261127_chat_cost_drop_prices.sql"
