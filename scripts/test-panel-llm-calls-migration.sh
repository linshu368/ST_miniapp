#!/usr/bin/env bash
# 20261126_panel_llm_calls.sql on disposable PG17 (--network none). No remote URI or business data.
# Builds the 2026-11-26 production shape of ops.llm_calls, the analytics cost views and the Grafana
# reader role, applies the migration twice and checks constraints, views and grants.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-panel-llm-calls-${RANDOM}-$$"
task_temp="$(mktemp -d)"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$task_temp"; }
trap cleanup EXIT
migration="$task_root/packages/shared/migrations/20261126_panel_llm_calls.sql"

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for task_attempt in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE ROLE grafana_cloud NOLOGIN IN ROLE first_token_metrics_reader;
CREATE SCHEMA ops; CREATE SCHEMA analytics; CREATE SCHEMA experience; CREATE SCHEMA billing;
GRANT USAGE ON SCHEMA analytics TO first_token_metrics_reader, service_role;
CREATE TABLE experience.chat_history(id uuid PRIMARY KEY, model text);
CREATE TABLE ops.llm_calls(
  id uuid PRIMARY KEY, attempt_id uuid, chat_history_id uuid NOT NULL, provider text NOT NULL,
  generation_id text, request_id text, model text, http_status integer, prompt_tokens bigint,
  completion_tokens bigint, cost_usd numeric, cost_source text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  lane text NOT NULL, role text, slot smallint, candidate_id text, dispatched_at timestamptz, end_reason text,
  CONSTRAINT llm_calls_attempt_is_id CHECK (attempt_id IS NULL OR attempt_id = id),
  CONSTRAINT llm_calls_lane_check CHECK (lane = ANY (ARRAY['chat'::text, 'free_zone'::text])),
  CONSTRAINT llm_calls_role_check CHECK (role IS NULL OR role = ANY (ARRAY['primary'::text, 'fallback'::text, 'rewrite'::text])),
  CONSTRAINT llm_calls_provider_check CHECK (provider = ANY (ARRAY['openrouter'::text, 'venice'::text, 'surplus'::text, 'packy'::text, 'onexmodel'::text])));
CREATE INDEX llm_calls_chat_history_idx ON ops.llm_calls(chat_history_id);
-- Production definitions (2026-11-26), including the two dependent views.
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
    l.prompt_tokens, l.completion_tokens
   FROM ops.llm_calls l LEFT JOIN experience.chat_history h ON h.id = l.chat_history_id
  WHERE l.dispatched_at IS NOT NULL;
CREATE VIEW analytics.llm_turn_costs AS
 SELECT chat_history_id, lane, model_id, min(dispatched_at) AS turn_at, COALESCE(sum(cost_usd), 0::numeric) AS total_cost_usd
   FROM analytics.llm_call_costs GROUP BY chat_history_id, lane, model_id;
CREATE VIEW analytics.free_zone_call_costs AS SELECT id, cost_usd FROM analytics.llm_call_costs WHERE lane = 'free_zone'::text;
GRANT SELECT ON analytics.llm_call_costs, analytics.llm_turn_costs, analytics.free_zone_call_costs TO service_role, first_token_metrics_reader;
CREATE TABLE billing.usage_charges(
  id uuid PRIMARY KEY, user_id uuid NOT NULL, kind text NOT NULL, subject_id uuid, status text NOT NULL,
  charged_credits numeric(14,1) NOT NULL DEFAULT 0, quote jsonb NOT NULL DEFAULT '{}'::jsonb,
  settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
-- Existing chat rows must keep validating.
INSERT INTO experience.chat_history VALUES ('c0000000-0000-4000-8000-000000000001', 'model-a');
INSERT INTO ops.llm_calls(id, chat_history_id, provider, lane, role, dispatched_at, cost_source, cost_usd)
  VALUES ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'openrouter', 'chat', 'primary', now(), 'openrouter_generation', 0.02);
SQL

def_before="$("${task_psql[@]}" -At -c "SELECT pg_get_viewdef('analytics.llm_call_costs'::regclass)")"
[[ "$def_before" == *'WHERE (l.dispatched_at IS NOT NULL);' ]] || { echo "FAIL: fixture view does not deparse like production" >&2; exit 1; }

"${task_psql[@]}" <"$migration" >/dev/null
def_after="$("${task_psql[@]}" -At -c "SELECT pg_get_viewdef('analytics.llm_call_costs'::regclass)")"
"${task_psql[@]}" <"$migration" >/dev/null
[[ "$("${task_psql[@]}" -At -c "SELECT pg_get_viewdef('analytics.llm_call_costs'::regclass)")" == "$def_after" ]] \
  || { echo "FAIL: replay changed llm_call_costs" >&2; exit 1; }
[[ "${def_after%%WHERE*}" == "${def_before%%WHERE*}" ]] || { echo "FAIL: llm_call_costs changed outside WHERE" >&2; exit 1; }

"${task_psql[@]}" <<'SQL'
DO $t$
DECLARE r record; n int;
BEGIN
  -- Shape: chat rows need a turn and no trigger; panel rows need a trigger and no turn.
  INSERT INTO ops.llm_calls(id, chat_history_id, provider, lane, role, dispatched_at)
    VALUES ('a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'surplus', 'free_zone', 'primary', now());
  INSERT INTO ops.llm_calls(id, provider, model, lane, role, panel_trigger, dispatched_at, end_reason, cost_source, cost_usd)
    VALUES ('b0000000-0000-4000-8000-000000000001', 'surplus', 'm1', 'status_bar', 'primary', 'auto', '2026-11-26 17:00:00+00', 'completed', 'surplus_buyer', 0.01),
           ('b0000000-0000-4000-8000-000000000002', 'openrouter', 'm2', 'status_bar', 'fallback', 'manual', '2026-11-26 15:00:00+00', 'http_429', 'unavailable', NULL),
           ('b0000000-0000-4000-8000-000000000003', 'openrouter', 'm2', 'memory_bar', 'fallback', 'auto', '2026-11-26 15:30:00+00', 'completed', NULL, NULL),
           ('b0000000-0000-4000-8000-000000000004', 'openrouter', 'm2', 'memory_bar', 'primary', 'manual', '2026-11-26 15:40:00+00', 'cancelled', 'estimated', 0.003);
  FOR r IN SELECT * FROM (VALUES
      ('chat', 'c0000000-0000-4000-8000-000000000001'::uuid, 'auto', 'chat row with trigger'),
      ('chat', NULL, NULL, 'chat row without turn'),
      ('status_bar', 'c0000000-0000-4000-8000-000000000001'::uuid, 'auto', 'panel row with turn'),
      ('memory_bar', NULL, NULL, 'panel row without trigger'),
      ('memory_bar', NULL, 'bogus', 'panel row with unknown trigger'),
      ('bogus', NULL, 'auto', 'unknown lane')) AS v(lane, hist, trig, label)
  LOOP
    BEGIN
      INSERT INTO ops.llm_calls(id, chat_history_id, provider, lane, panel_trigger, dispatched_at)
        VALUES (gen_random_uuid(), r.hist, 'openrouter', r.lane, r.trig, now());
      RAISE EXCEPTION 'accepted: %', r.label;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- Per-turn cost views keep chat lanes only.
  SELECT count(*) INTO n FROM analytics.llm_call_costs;
  IF n <> 2 THEN RAISE EXCEPTION 'llm_call_costs rows %', n; END IF;
  IF EXISTS (SELECT 1 FROM analytics.llm_turn_costs WHERE chat_history_id IS NULL) THEN RAISE EXCEPTION 'null turn in llm_turn_costs'; END IF;

  -- Panel cost view: Beijing day, cost states, no cost for pending / missing.
  SELECT * INTO r FROM analytics.panel_call_costs WHERE id = 'b0000000-0000-4000-8000-000000000001';
  IF r.day_cn <> '2026-11-27' OR r.panel <> 'status' OR r.panel_trigger <> 'auto' OR NOT r.returned
     OR r.cost_state <> 'known' OR r.cost_usd <> 0.01 THEN RAISE EXCEPTION 'known row %', to_jsonb(r); END IF;
  SELECT * INTO r FROM analytics.panel_call_costs WHERE id = 'b0000000-0000-4000-8000-000000000002';
  IF r.day_cn <> '2026-11-26' OR r.cost_state <> 'missing' OR r.cost_usd IS NOT NULL OR r.returned THEN RAISE EXCEPTION 'missing row %', to_jsonb(r); END IF;
  SELECT * INTO r FROM analytics.panel_call_costs WHERE id = 'b0000000-0000-4000-8000-000000000003';
  IF r.panel <> 'memory' OR r.cost_state <> 'pending' OR r.cost_usd IS NOT NULL THEN RAISE EXCEPTION 'pending row %', to_jsonb(r); END IF;
  SELECT * INTO r FROM analytics.panel_call_costs WHERE id = 'b0000000-0000-4000-8000-000000000004';
  IF r.cost_state <> 'estimated' OR r.cost_usd <> 0.003 THEN RAISE EXCEPTION 'estimated row %', to_jsonb(r); END IF;
  SELECT count(*) INTO n FROM analytics.panel_call_costs;
  IF n <> 4 THEN RAISE EXCEPTION 'panel rows %', n; END IF;

  -- Revenue view: charged with split, failed with zero.
  INSERT INTO billing.usage_charges(id, user_id, kind, status, charged_credits, quote, settled_at) VALUES
    ('d0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'status_refresh', 'charged', 6, '{"charge":{"main_credits":2,"bonus_credits":4}}', '2026-11-26 16:30:00+00'),
    ('d0000000-0000-4000-8000-000000000002', gen_random_uuid(), 'status_refresh', 'failed', 0, '{"charge":{"error_code":"TOTAL_CREDITS_INSUFFICIENT"}}', '2026-11-26 01:00:00+00'),
    ('d0000000-0000-4000-8000-000000000003', gen_random_uuid(), 'chat_text', 'charged', 12, '{}', now());
  SELECT * INTO r FROM analytics.panel_refresh_revenue WHERE id = 'd0000000-0000-4000-8000-000000000001';
  IF r.day_cn <> '2026-11-27' OR r.credits <> 6 OR r.main_credits <> 2 OR r.bonus_credits <> 4 THEN RAISE EXCEPTION 'charged revenue %', to_jsonb(r); END IF;
  SELECT * INTO r FROM analytics.panel_refresh_revenue WHERE id = 'd0000000-0000-4000-8000-000000000002';
  IF r.status <> 'failed' OR r.credits <> 0 OR r.main_credits <> 0 THEN RAISE EXCEPTION 'failed revenue %', to_jsonb(r); END IF;
  SELECT count(*) INTO n FROM analytics.panel_refresh_revenue;
  IF n <> 2 THEN RAISE EXCEPTION 'revenue rows %', n; END IF;

  -- Constraints validated, index valid.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ops.llm_calls'::regclass
             AND conname IN ('llm_calls_lane_check', 'llm_calls_panel_shape_check') AND NOT convalidated) THEN
    RAISE EXCEPTION 'constraint not validated';
  END IF;
END;
$t$;

-- Grafana reader sees the new views only through analytics; API roles see nothing.
SET ROLE grafana_cloud;
SELECT count(*) FROM analytics.panel_call_costs;
SELECT count(*) FROM analytics.panel_refresh_revenue;
SELECT count(*) FROM analytics.llm_call_costs;
RESET ROLE;
DO $p$
BEGIN
  IF has_table_privilege('grafana_cloud', 'ops.llm_calls', 'SELECT')
     OR has_table_privilege('grafana_cloud', 'billing.usage_charges', 'SELECT')
     OR has_table_privilege('anon', 'analytics.panel_call_costs', 'SELECT')
     OR has_table_privilege('authenticated', 'analytics.panel_refresh_revenue', 'SELECT')
     OR NOT has_table_privilege('service_role', 'analytics.panel_call_costs', 'SELECT') THEN
    RAISE EXCEPTION 'grants differ';
  END IF;
END;
$p$;
SQL

# A different llm_call_costs definition must abort the whole migration.
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE OR REPLACE VIEW analytics.llm_call_costs AS
 SELECT l.id, l.chat_history_id, l.lane, NULL::text AS model_id, l.role, l.slot, l.provider, l.model AS provider_model,
   l.dispatched_at, l.end_reason, false AS won, l.cost_source, false AS cost_pending, false AS cost_estimated,
   l.cost_usd, l.prompt_tokens, l.completion_tokens
 FROM ops.llm_calls l WHERE l.dispatched_at IS NOT NULL AND l.provider <> 'venice';
SQL
if "${task_psql[@]}" <"$migration" >/dev/null 2>"$task_temp/tamper.err"; then
  echo "FAIL: migration accepted an unknown llm_call_costs definition" >&2; exit 1
fi
grep -q "llm_call_costs definition differs" "$task_temp/tamper.err" || { cat "$task_temp/tamper.err" >&2; exit 1; }

echo "panel llm_calls migration: OK"
