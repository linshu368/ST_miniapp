#!/usr/bin/env bash
# 畅聊上游调用花费表 migration on disposable PG17. No remote URI, user data, model or billing calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="free-zone-calls-pg-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)

"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE SCHEMA miniapp_features;
CREATE SCHEMA miniapp_analytics;
GRANT USAGE ON SCHEMA miniapp_analytics TO first_token_metrics_reader;
SQL

# Apply twice: a retried workflow run must be a no-op.
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261116_free_zone_calls.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261116_free_zone_calls.sql" >/dev/null

"${task_psql[@]}" >/dev/null <<'SQL'
DO $assert$
DECLARE v_failed boolean;
BEGIN
  -- 一轮：并发两路（一路胜出、一路被取消没请求号）+ 一个被取消的兜底
  INSERT INTO miniapp_features.free_zone_calls
    (id, chat_history_id, candidate_id, role, slot, provider, provider_model, dispatched_at,
     end_reason, request_id, cost_usd, cost_source, settled_at)
  VALUES
    ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'free-g38',
     'primary', 0, 'surplus', 'gemini-3.8-flash', now(), 'first_token_observed', 'req-1', 0.0016, 'surplus_bill', now()),
    ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'free-g38',
     'primary', 1, 'surplus', 'gemini-3.8-flash', now(), 'cancelled', NULL, NULL, 'unavailable', now()),
    ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'free-g38',
     'fallback', 0, 'openrouter', 'deepseek/x', now(), 'cancelled', NULL, 0.0004, 'estimated', now()),
  -- 另一轮：花费还没核算
    ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', 'free-g38',
     'primary', 0, 'surplus', 'gemini-3.8-flash', now(), 'first_token_observed', 'req-2', NULL, NULL, NULL);

  ASSERT (SELECT total_cost_usd FROM miniapp_analytics.free_zone_turn_costs
          WHERE chat_history_id = 'a0000000-0000-4000-8000-000000000001') = 0.0020,
    'turn total = winner + unpriced loser (0) + estimated fallback';
  ASSERT (SELECT (primary_calls, fallback_calls, estimated_cost_usd, cost_pending)
          FROM miniapp_analytics.free_zone_turn_costs
          WHERE chat_history_id = 'a0000000-0000-4000-8000-000000000001') = (2::bigint, 1::bigint, 0.0004, false);
  ASSERT (SELECT cost_pending AND total_cost_usd = 0 FROM miniapp_analytics.free_zone_turn_costs
          WHERE chat_history_id = 'a0000000-0000-4000-8000-000000000002'), 'pending turns are flagged';
  ASSERT (SELECT cost_usd FROM miniapp_analytics.free_zone_call_costs
          WHERE id = 'c0000000-0000-4000-8000-000000000002') = 0, 'unpriced counts as 0';

  -- invariants
  v_failed := false;
  BEGIN
    INSERT INTO miniapp_features.free_zone_calls
      (id, chat_history_id, candidate_id, role, slot, provider, provider_model, dispatched_at, end_reason)
    VALUES ('c0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'free-g38',
      'primary', 1, 'surplus', 'gemini-3.8-flash', now(), 'cancelled');
  EXCEPTION WHEN unique_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'one row per turn, role and slot';
  v_failed := false;
  BEGIN
    UPDATE miniapp_features.free_zone_calls SET cost_source = 'surplus_bill', settled_at = now()
    WHERE id = 'c0000000-0000-4000-8000-000000000004';
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'a priced source needs a cost';
  v_failed := false;
  BEGIN
    UPDATE miniapp_features.free_zone_calls SET cost_source = 'unavailable'
    WHERE id = 'c0000000-0000-4000-8000-000000000004';
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'settled rows carry settled_at';

  -- access
  ASSERT has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.free_zone_turn_costs', 'SELECT');
  ASSERT has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.free_zone_call_costs', 'SELECT');
  ASSERT NOT has_table_privilege('first_token_metrics_reader', 'miniapp_features.free_zone_calls', 'SELECT');
  ASSERT NOT has_table_privilege('anon', 'miniapp_features.free_zone_calls', 'SELECT');
  ASSERT NOT has_table_privilege('authenticated', 'miniapp_analytics.free_zone_turn_costs', 'SELECT');
  ASSERT NOT has_table_privilege('service_role', 'miniapp_features.free_zone_calls', 'DELETE');
END
$assert$;
SQL

"${task_psql[@]}" -Atqc "SET ROLE first_token_metrics_reader; SELECT count(*) FROM miniapp_analytics.free_zone_turn_costs;" | grep -qx 2
printf 'PASS: free zone calls PG17 (turn totals, unpriced=0, estimates, invariants, grants, re-run)\n'
