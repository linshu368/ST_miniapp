#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6a2c3_prompt_estimate.sql as a NON-superuser:
# - an estimated call takes the same-model sibling's prompt tokens × the model's input price (9 decimals);
# - without a same-model sibling it takes another sibling's prompt tokens;
# - no sibling with prompt tokens → unavailable, cost cleared;
# - a model outside the price table and non-estimated calls are untouched;
# - the 14-day grafana refresh runs under the advisory lock; rerun keeps the values.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261120_db_reorg_p6a2c3_prompt_estimate.sql"
task_container="st-db-reorg-p6a2c3e-${RANDOM}-$$"
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
psql_f >/dev/null <<'SQL'
CREATE SCHEMA ops; CREATE SCHEMA miniapp_analytics;
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY, chat_history_id uuid, provider text NOT NULL, model text, prompt_tokens bigint,
  cost_usd numeric, cost_source text, dispatched_at timestamptz, end_reason text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE miniapp_analytics.refreshed (day date);
CREATE FUNCTION miniapp_analytics.refresh_grafana_core_day(p_day date) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  -- the migration must already hold the dashboard refresh lock
  IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 20261026 AND objid = 510
                 AND pid = pg_backend_pid() AND granted) THEN
    RAISE EXCEPTION 'refresh lock not held';
  END IF;
  INSERT INTO miniapp_analytics.refreshed VALUES (p_day);
  RETURN true;
END $$;
-- turn A: stopped flash call + delivered same-model sibling (20000 tokens) + other-model sibling (99999)
-- turn B: stopped glm call, only an other-model sibling (30000)
-- turn C: stopped flash call, no sibling with prompt tokens
-- turn D: stopped call on a model outside the price table; a delivered call with a real cost
INSERT INTO ops.llm_calls (id, chat_history_id, provider, model, prompt_tokens, cost_usd, cost_source, dispatched_at, end_reason) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017', NULL, 0.031, 'estimated', now() - interval '2 days', 'cancelled'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017', 20000, 0.004, 'openrouter_usage', now() - interval '2 days', 'completed'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000a', 'surplus', 'other/model', 99999, 0.001, 'surplus_buyer', now() - interval '2 days' - interval '1 second', 'cancelled'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'openrouter', 'z-ai/glm-5.2', NULL, 0.031, 'estimated', now() - interval '9 days', 'first_token_deadline'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', 'surplus', 'other/model', 30000, 0.001, 'surplus_buyer', now() - interval '9 days', 'completed'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000c', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017', NULL, 0.031, 'estimated', now() - interval '1 day', 'cancelled'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000d', 'openrouter', 'brand/new-model', NULL, 0.031, 'estimated', now() - interval '1 day', 'cancelled'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000000d', 'openrouter', 'brand/new-model', 1000, 0.002, 'openrouter_usage', now() - interval '1 day', 'completed');
SQL
cost() { psql_f -At -c "SELECT COALESCE(cost_usd::text, 'null') || ':' || cost_source FROM ops.llm_calls WHERE id = '00000000-0000-0000-0000-0000000000$1'"; }
expect() { local got; got=$(cost "$1"); [[ "$got" == "$2" ]] || { echo "FAIL: call $1 expected $2 got $got"; exit 1; }; }

out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'re-estimated calls (estimated 2, now unavailable 1)'* && "$out" == *'14 days of grafana_core_daily refreshed'* ]] ||
  { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: three priced-model calls re-estimated, refresh ran'
expect a1 '0.003000000:estimated'     # 20000 × 0.00000015 (same-model sibling wins over the larger other-model one)
expect b1 '0.018600000:estimated'     # 30000 × 0.00000062, older than 7 days too
expect c1 'null:unavailable'
expect d1 '0.031:estimated'           # model outside the price table: untouched
expect a2 '0.004:openrouter_usage'
expect d2 '0.002:openrouter_usage'
echo 'ok: sibling choice, unavailable fallback, untouched rows'
check 'refresh covered 14 distinct days ending today (Asia/Shanghai)' <<'SQL'
SELECT count(DISTINCT day) = 14 AND max(day) = (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date FROM miniapp_analytics.refreshed;
SQL
psql_f <"$migration" >/dev/null 2>&1
expect a1 '0.003000000:estimated'
expect b1 '0.018600000:estimated'
expect c1 'null:unavailable'
echo 'ok: rerun keeps the values'
echo 'all checks passed'
