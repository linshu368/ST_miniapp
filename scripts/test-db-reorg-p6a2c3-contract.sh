#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2c3_free_zone_calls_contract.sql as a NON-superuser (after the expand file):
# - the two free-zone cost views return the same rows before and after (call rows compared without id/dispatch time) (now a lane = free_zone subset of
#   llm_call_costs / llm_turn_costs), grants kept, miniapp_features.free_zone_calls dropped, rerun is a no-op;
# - it refuses (and changes nothing) while free_zone_calls still receives rows or a call is missing from ops.llm_calls.
# The expand-file checks live in scripts/test-db-reorg-p6a2c3-migration.sh; the fixture below is the same.
#
# - new columns/constraints/indexes: the Surplus one-row-per-turn rule now only binds the row representing the attempt,
#   so free-zone Surplus slots coexist; the cost-pending index exists; cost jobs accept call_cost and up to 8 attempts;
# - paid attempts of the last 7 days: existing rows get role/dispatched_at/end_reason without touching costs, missing
#   undelivered calls get rows with cost pending, older attempts are left alone;
# - free-zone calls: the slot representing each attempt joins the attempt's row (by generation_id; else the winner),
#   other slots get their own rows with their costs; known costs are never overwritten; OpenRouter lookups carry over;
# - per-turn totals: llm_turn_costs for the free-zone turn equals free_zone_turn_costs, the paid turn sums both calls;
# - discarded fragments move to discarded_detail (old attempts get a row with cost unavailable);
# - the metadata-gap scan (production body, md5 checked) no longer lists turns missing only finish_reason;
# - view grants; a rerun changes nothing; a drifted gap function is refused.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2c3_call_ledger_expand.sql"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2c3_free_zone_calls_contract.sql"
task_container="st-db-reorg-p6a2c3c-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE first_token_metrics_reader NOLOGIN;
GRANT anon, authenticated, service_role, first_token_metrics_reader TO app_admin;
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
DROP SCHEMA IF EXISTS experience, ops, miniapp_features, miniapp_analytics CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA ops; CREATE SCHEMA miniapp_features; CREATE SCHEMA miniapp_analytics;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid, session_id uuid, model text, status text NOT NULL DEFAULT 'success',
  llm_finish_reason text, llm_charge_id uuid, assistant_reply text, llm_billing_snapshot jsonb,
  llm_billing_settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_generation_attempts (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL REFERENCES experience.chat_history(id),
  role text NOT NULL, provider text NOT NULL, provider_model_id text NOT NULL, generation_id text,
  dispatched_at timestamptz, dispatch_offset_ms numeric, first_token_ms numeric, observed_until_ms numeric,
  end_reason text, finish_reason text, updated_at timestamptz NOT NULL DEFAULT now(), discarded_response jsonb);
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id), delivery_attempt_id uuid);
-- ops.llm_calls / ops.llm_cost_jobs: production shape after 6a-2c-2 (20261119_db_reorg_p6a2c1/2 expand)
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY, attempt_id uuid UNIQUE, chat_history_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'venice', 'surplus')),
  generation_id text, request_id text, provider_name text, model text, finish_reason text, call_status text,
  error_code text, http_status integer, prompt_tokens bigint, completion_tokens bigint, cached_tokens bigint,
  reasoning_tokens bigint, cost_usd numeric CHECK (cost_usd IS NULL OR cost_usd >= 0), cache_cost_usd numeric,
  cost_source text, latency_ms numeric, generation_time_ms numeric, raw_request jsonb, raw_usage jsonb,
  discarded_detail jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  total_tokens bigint, reported_cost_usd numeric, capture_status text,
  CONSTRAINT llm_calls_attempt_is_id CHECK (attempt_id IS NULL OR attempt_id = id));
CREATE INDEX llm_calls_chat_history_idx ON ops.llm_calls (chat_history_id);
CREATE UNIQUE INDEX llm_calls_surplus_turn_idx ON ops.llm_calls (chat_history_id) WHERE provider = 'surplus';
CREATE TABLE ops.llm_cost_jobs (
  call_id uuid PRIMARY KEY REFERENCES ops.llm_calls(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT llm_cost_jobs_kind_check CHECK (kind = 'surplus_request_record'),
  status text NOT NULL, attempts integer NOT NULL DEFAULT 0
    CONSTRAINT llm_cost_jobs_attempts_check CHECK (attempts >= 0 AND attempts <= 6),
  next_retry_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
-- miniapp_features.free_zone_calls (20261116_free_zone_calls.sql shape) and its two analysis views
CREATE TABLE miniapp_features.free_zone_calls (
  id uuid PRIMARY KEY, chat_history_id uuid NOT NULL, candidate_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('primary', 'fallback')), slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 2),
  provider text NOT NULL, provider_model text NOT NULL, dispatched_at timestamptz NOT NULL, end_reason text NOT NULL,
  request_id text, generation_id text, cost_usd numeric(20,9), cost_source text, prompt_tokens bigint,
  completion_tokens bigint, cost_attempts integer NOT NULL DEFAULT 0, settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (chat_history_id, role, slot));
CREATE VIEW miniapp_analytics.free_zone_call_costs AS
SELECT id, chat_history_id, candidate_id AS model_id, role, slot, provider, provider_model, dispatched_at, end_reason,
  (end_reason = 'first_token_observed') AS won, cost_source, (cost_source IS NULL) AS cost_pending,
  (cost_source = 'estimated') AS cost_estimated,
  CASE WHEN cost_source IS NOT NULL THEN COALESCE(cost_usd, 0) ELSE NULL END AS cost_usd, prompt_tokens, completion_tokens
FROM miniapp_features.free_zone_calls c;
CREATE VIEW miniapp_analytics.free_zone_turn_costs AS
SELECT chat_history_id, model_id, min(dispatched_at) AS turn_at,
  count(*) FILTER (WHERE role = 'primary') AS primary_calls, count(*) FILTER (WHERE role = 'fallback') AS fallback_calls,
  COALESCE(sum(cost_usd) FILTER (WHERE role = 'primary'), 0) AS primary_cost_usd,
  COALESCE(sum(cost_usd) FILTER (WHERE role = 'fallback'), 0) AS fallback_cost_usd,
  COALESCE(sum(cost_usd), 0) AS total_cost_usd,
  COALESCE(sum(cost_usd) FILTER (WHERE cost_estimated), 0) AS estimated_cost_usd, bool_or(cost_pending) AS cost_pending
FROM miniapp_analytics.free_zone_call_costs GROUP BY chat_history_id, model_id;

-- Turn P (paid): delivered OpenRouter primary with metadata row; undelivered OpenRouter fallback without a row.
INSERT INTO experience.chat_history (id, model, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'paid-model', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000b', 'free-model', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000c', 'free-model', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000000d', 'paid-model', now() - interval '10 days');
INSERT INTO experience.chat_generation_attempts
  (id, chat_history_id, role, provider, provider_model_id, generation_id, dispatched_at, end_reason, discarded_response) VALUES
  ('00000000-0000-0000-0001-00000000000a', '00000000-0000-0000-0000-00000000000a', 'primary', 'openrouter', 'or/m', 'gen-pa',
   now() - interval '1 hour', 'first_token_observed', NULL),
  ('00000000-0000-0000-0002-00000000000a', '00000000-0000-0000-0000-00000000000a', 'fallback', 'openrouter', 'or/fb', 'gen-pb',
   now() - interval '1 hour', 'cancelled', '{"reason":"race_lost","content":"x"}'),
  -- Turn F (free zone): Surplus primary attempt (3 slots, owner = gen-f1), OpenRouter fallback attempt without a row.
  ('00000000-0000-0000-0001-00000000000b', '00000000-0000-0000-0000-00000000000b', 'primary', 'surplus', 's/m', 'gen-f1',
   now() - interval '1 hour', 'first_token_observed', NULL),
  ('00000000-0000-0000-0002-00000000000b', '00000000-0000-0000-0000-00000000000b', 'fallback', 'openrouter', 'or/fb', 'gen-ff',
   now() - interval '1 hour', 'cancelled', NULL),
  -- Turn G (free zone, attempt without generation_id, 2 slots: owner = the winner)
  -- (the attempt's end_reason is written by the slot that represents it, so it matches that slot's)
  ('00000000-0000-0000-0001-00000000000c', '00000000-0000-0000-0000-00000000000c', 'primary', 'surplus', 's/m', NULL,
   now() - interval '2 hours', 'first_token_observed', NULL),
  -- Turn O (paid, 10 days old): no row is created; its discarded fragment still moves (cost unavailable)
  ('00000000-0000-0000-0001-00000000000d', '00000000-0000-0000-0000-00000000000d', 'primary', 'venice', 'v/m', NULL,
   now() - interval '10 days', 'cancelled', '{"reason":"race_lost","content":"old"}');
INSERT INTO experience.chat_generation_requests VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0001-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0001-00000000000b');
INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, model, generation_id, cost_usd, cost_source, raw_usage,
                           finish_reason) VALUES
  ('00000000-0000-0000-0001-00000000000a', '00000000-0000-0000-0001-00000000000a', '00000000-0000-0000-0000-00000000000a',
   'openrouter', 'or/m', 'gen-pa', 0.020000000, 'openrouter_usage', '{}', NULL),
  ('00000000-0000-0000-0001-00000000000b', '00000000-0000-0000-0001-00000000000b', '00000000-0000-0000-0000-00000000000b',
   'surplus', 's/m', 'gen-f1', 0.000400000, 'surplus_buyer', '{}', 'stop'),
  ('00000000-0000-0000-0001-00000000000c', '00000000-0000-0000-0001-00000000000c', '00000000-0000-0000-0000-00000000000c',
   'surplus', 's/m', NULL, NULL, NULL, NULL, NULL);
INSERT INTO ops.llm_cost_jobs (call_id, kind, status, attempts) VALUES
  ('00000000-0000-0000-0001-00000000000b', 'surplus_request_record', 'complete', 1);
INSERT INTO miniapp_features.free_zone_calls
  (id, chat_history_id, candidate_id, role, slot, provider, provider_model, dispatched_at, end_reason, request_id,
   generation_id, cost_usd, cost_source, cost_attempts) VALUES
  ('00000000-0000-0000-0003-0000000000b0', '00000000-0000-0000-0000-00000000000b', 'cand-1', 'primary', 0, 'surplus', 's/m',
   now() - interval '1 hour', 'first_token_observed', 'req-1', 'gen-f1', 0.000400000, 'surplus_bill', 0),
  ('00000000-0000-0000-0003-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'cand-1', 'primary', 1, 'surplus', 's/m',
   now() - interval '1 hour', 'cancelled', 'req-2', NULL, 0.000100000, 'surplus_bill_matched', 0),
  ('00000000-0000-0000-0003-0000000000b2', '00000000-0000-0000-0000-00000000000b', 'cand-1', 'primary', 2, 'surplus', 's/m',
   now() - interval '1 hour', 'cancelled', NULL, NULL, NULL, 'unavailable', 0),
  ('00000000-0000-0000-0003-0000000000bf', '00000000-0000-0000-0000-00000000000b', 'cand-1', 'fallback', 0, 'openrouter',
   'or/fb', now() - interval '1 hour', 'cancelled', NULL, 'gen-ff', NULL, NULL, 3),
  ('00000000-0000-0000-0003-0000000000c0', '00000000-0000-0000-0000-00000000000c', 'cand-2', 'primary', 0, 'surplus', 's/m',
   now() - interval '2 hours', 'cancelled', NULL, NULL, 0.000050000, 'surplus_bill', 0),
  ('00000000-0000-0000-0003-0000000000c1', '00000000-0000-0000-0000-00000000000c', 'cand-2', 'primary', 1, 'surplus', 's/m',
   now() - interval '2 hours', 'first_token_observed', NULL, NULL, 0.000300000, 'surplus_bill', 0);
UPDATE miniapp_features.free_zone_calls SET created_at = now() - interval '1 hour';
SQL
  psql_f >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION experience.list_llm_call_metadata_gaps(p_since timestamp with time zone, p_limit integer)
 RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamp with time zone, delivery_provider text, generation_id text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $prodfn$
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  LEFT JOIN ops.llm_calls l ON l.id = a.id
  WHERE h.created_at >= p_since
    AND h.status <> 'streaming'
    AND a.provider = 'openrouter'
    AND a.generation_id IS NOT NULL
    AND (l.id IS NULL OR l.raw_usage IS NULL OR l.cost_usd IS NULL OR l.latency_ms IS NULL
      OR l.generation_time_ms IS NULL OR l.finish_reason IS NULL)
  ORDER BY h.created_at DESC, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$prodfn$;
SQL
}


# Call rows are compared without id / dispatched_at: the slot representing an attempt now lives in the attempt's row.
views() { psql_f -At -c "SELECT md5(string_agg(row(c.chat_history_id, c.model_id, c.role, c.slot, c.provider, c.provider_model, c.end_reason, c.won, c.cost_source, c.cost_pending, c.cost_estimated, c.cost_usd, c.prompt_tokens, c.completion_tokens)::text, ',' ORDER BY c.chat_history_id, c.role, c.slot)) FROM miniapp_analytics.free_zone_call_costs c" -c "SELECT md5(string_agg(row(t.chat_history_id, t.model_id, t.primary_calls, t.fallback_calls, t.primary_cost_usd, t.fallback_cost_usd, t.total_cost_usd, t.estimated_cost_usd, t.cost_pending)::text, ',' ORDER BY t.chat_history_id)) FROM miniapp_analytics.free_zone_turn_costs t"; }
fixture
psql_f <"$expand" >/dev/null 2>&1
# the expand file keeps the attempt row's known cost; align the fixture so the turn totals are comparable 1:1
psql_f -c "UPDATE miniapp_features.free_zone_calls SET cost_usd = 0.000400000, cost_source = 'surplus_buyer' WHERE id = '00000000-0000-0000-0003-0000000000b0'" >/dev/null
before=$(views | tr '\n' ' ')

# Refusal 1: the old table still receives rows.
psql_f -c "INSERT INTO miniapp_features.free_zone_calls (id, chat_history_id, candidate_id, role, slot, provider, provider_model, dispatched_at, end_reason) VALUES ('00000000-0000-0000-0004-000000000001', '00000000-0000-0000-0000-00000000000c', 'cand-2', 'fallback', 0, 'openrouter', 'or/fb', now(), 'cancelled')" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: recent rows not refused"; exit 1; fi
[[ "$out" == *'still receives rows'* ]] || { echo "FAIL: recent-row message: $out"; exit 1; }
echo 'ok: refused while the old table still receives rows'
# Refusal 2: a call that is not in ops.llm_calls.
psql_f -c "UPDATE miniapp_features.free_zone_calls SET created_at = now() - interval '1 hour' WHERE id = '00000000-0000-0000-0004-000000000001'" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: missing call not refused"; exit 1; fi
[[ "$out" == *'free-zone calls are not in ops.llm_calls'* ]] || { echo "FAIL: missing-call message: $out"; exit 1; }
check 'refusals changed nothing' <<'SQL'
SELECT to_regclass('miniapp_features.free_zone_calls') IS NOT NULL
  AND pg_get_viewdef('miniapp_analytics.free_zone_call_costs'::regclass) LIKE '%free_zone_calls%';
SQL
echo 'ok: refused while a call is missing from ops.llm_calls'
# Rerunning the expand file copies the delta; then the contract goes through.
psql_f <"$expand" >/dev/null 2>&1
psql_f -c "DELETE FROM ops.llm_calls WHERE id = '00000000-0000-0000-0004-000000000001'" >/dev/null
psql_f -c "DELETE FROM miniapp_features.free_zone_calls WHERE id = '00000000-0000-0000-0004-000000000001'" >/dev/null
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'free_zone_calls dropped'* ]] || { echo "FAIL: contract output: $out"; exit 1; }
after=$(views | tr '\n' ' ')
[[ "$before" == "$after" ]] || { echo "FAIL: free-zone views changed: $before vs $after"; exit 1; }
echo "ok: free-zone views return identical rows ($after)"
check 'old table dropped, views read the new views, grants kept' <<'SQL'
SELECT to_regclass('miniapp_features.free_zone_calls') IS NULL
  AND pg_get_viewdef('miniapp_analytics.free_zone_call_costs'::regclass) LIKE '%llm_call_costs%'
  AND pg_get_viewdef('miniapp_analytics.free_zone_turn_costs'::regclass) LIKE '%llm_turn_costs%'
  AND has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.free_zone_turn_costs', 'SELECT')
  AND has_table_privilege('service_role', 'miniapp_analytics.free_zone_call_costs', 'SELECT')
  AND NOT has_table_privilege('anon', 'miniapp_analytics.free_zone_turn_costs', 'SELECT');
SQL
psql_f <"$migration" >/dev/null 2>&1 || { echo 'FAIL: rerun failed'; exit 1; }
[[ "$(views | tr '\n' ' ')" == "$after" ]] || { echo 'FAIL: rerun changed views'; exit 1; }
echo 'ok: rerun is a no-op'
echo 'all checks passed'
