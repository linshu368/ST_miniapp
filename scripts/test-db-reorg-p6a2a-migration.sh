#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p6a2a_attempt_columns.sql as a NON-superuser with CREATEROLE, on top of 6a-1:
# - fixture functions and views are the production ones before 6a-1 (md5 checked against production 2026-11-19),
#   then 20261119_db_reorg_p6a1_request_timing_cleanup.sql is applied as the starting shape;
# - the migration refuses (and changes nothing) when one observe anchor drifted or another view reads attempts;
# - one set of attempt observations (full / later replay / slim backend payload / race loser + replay / generation
#   conflict / route rebind) gives identical kept columns, terminal behaviour and refusals before and after;
# - chat_first_token_facts (35 kept columns) and free_zone_turn_facts are row-for-row identical, grants and reloptions
#   kept; the backend free-zone quality query still runs; the seven attempt columns are gone;
# - a rerun only prints "already applied".
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p6a2a_attempt_columns.sql"
p6a1="$task_root/packages/shared/migrations/20261119_db_reorg_p6a1_request_timing_cleanup.sql"
task_container="st-db-reorg-p6a2a-${RANDOM}-$$"
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
apply() { "${admin_psql[@]}" <"$migration"; }

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture mirrors the production shape collected on 2026-11-19 (only what this change touches or reads).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN;
GRANT anon, authenticated, service_role, first_token_metrics_reader TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA experience; CREATE SCHEMA billing; CREATE SCHEMA miniapp_analytics;
CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA experience, billing, miniapp_analytics, test_fixture TO service_role;
GRANT USAGE ON SCHEMA miniapp_analytics TO first_token_metrics_reader;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid, revision integer, status text NOT NULL,
  llm_finish_reason text, assistant_reply text, llm_charge_id uuid, llm_billing_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON experience.chat_history TO service_role;
CREATE TABLE experience.chat_generation_attempts (
  id uuid NOT NULL PRIMARY KEY, chat_history_id uuid NOT NULL REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role = ANY (ARRAY['primary'::text, 'fallback'::text])), provider text NOT NULL,
  provider_model_id text NOT NULL, generation_id text, dispatched_at timestamptz, dispatch_offset_ms numeric,
  headers_ms numeric, first_chunk_ms numeric, first_token_ms numeric, observed_until_ms numeric, http_status integer,
  end_reason text, provider_latency_ms numeric,
  provider_latency_scope text NOT NULL DEFAULT 'provider_defined_including_reasoning'::text, provider_name text,
  provider_reported_model text, finish_reason text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  discarded_response jsonb,
  CONSTRAINT chat_generation_attempt_role_unique UNIQUE (chat_history_id, role),
  CONSTRAINT chat_generation_attempt_history_id_unique UNIQUE (chat_history_id, id));
GRANT ALL ON experience.chat_generation_attempts TO service_role;
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid NOT NULL PRIMARY KEY REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL, mode text NOT NULL CHECK (mode = ANY (ARRAY['send'::text, 'regenerate'::text])),
  request_received_at timestamptz NOT NULL, requested_model_id text NOT NULL,
  requested_provider text NOT NULL CHECK (requested_provider = ANY (ARRAY['openrouter'::text, 'venice'::text, 'surplus'::text])),
  requested_provider_model_id text NOT NULL, catalog_version integer NOT NULL CHECK (catalog_version >= 0),
  primary_timeout_ms integer NOT NULL CHECK (primary_timeout_ms > 0), first_token_deadline_ms integer NOT NULL,
  timeout_rate_target numeric NOT NULL CHECK ((timeout_rate_target >= 0) AND (timeout_rate_target <= 1)),
  fallback_model_id text NOT NULL DEFAULT 'deepseek/deepseek-v4.1-flash'::text,
  fallback_triggered_ms numeric CHECK (fallback_triggered_ms >= 0), delivery_attempt_id uuid,
  first_token_emitted_ms numeric CHECK (first_token_emitted_ms >= 0), first_token_timeout boolean NOT NULL DEFAULT false,
  billing_rejected boolean NOT NULL DEFAULT false,
  client_outcome text NOT NULL DEFAULT 'missing'::text CHECK (client_outcome = ANY (ARRAY['missing'::text, 'observed'::text, 'timed_out'::text, 'not_observed'::text])),
  client_first_token_visible_ms numeric CHECK (client_first_token_visible_ms >= 0),
  client_request_dispatched_ms numeric CHECK (client_request_dispatched_ms >= 0),
  client_first_token_received_ms numeric CHECK (client_first_token_received_ms >= 0),
  client_backgrounded boolean, measurement_method text, client_reason text, client_reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), fallback_timeout_ms integer,
  client_wait_finished_ms numeric CHECK (client_wait_finished_ms >= 0),
  server_timeout_stage text CHECK (server_timeout_stage = ANY (ARRAY['global'::text, 'primary'::text, 'fallback'::text])),
  requires_visible_token boolean NOT NULL DEFAULT true, user_stop_billing_enabled boolean NOT NULL DEFAULT true,
  recoverable_delivery boolean NOT NULL DEFAULT false, client_delivery_failed boolean NOT NULL DEFAULT false,
  server_first_token_ready_ms numeric CHECK (server_first_token_ready_ms >= 0), first_token_preview jsonb,
  CONSTRAINT chat_generation_client_observation_check CHECK ((client_outcome = 'observed'::text) = (client_first_token_visible_ms IS NOT NULL)),
  CONSTRAINT chat_generation_requests_check CHECK ((first_token_deadline_ms > primary_timeout_ms) AND (first_token_deadline_ms <= 110000)),
  CONSTRAINT chat_generation_requests_check1 CHECK ((fallback_timeout_ms > 0) AND (fallback_timeout_ms < first_token_deadline_ms)),
  CONSTRAINT chat_generation_delivery_fk FOREIGN KEY (chat_history_id, delivery_attempt_id)
    REFERENCES experience.chat_generation_attempts(chat_history_id, id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX chat_generation_requests_window_idx ON experience.chat_generation_requests (request_received_at, requested_model_id);
CREATE INDEX chat_generation_requests_client_idx ON experience.chat_generation_requests (client_request_id);
GRANT SELECT, INSERT, UPDATE ON experience.chat_generation_requests TO service_role;
CREATE TABLE experience.surplusintelligence_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_history_id uuid NOT NULL REFERENCES experience.chat_history(id),
  provider_name text, buyer_cost_micro numeric, prompt_tokens bigint, cached_tokens bigint);
GRANT ALL ON experience.surplusintelligence_chat_history TO service_role;
CREATE TABLE billing.character_free_chat_quota_decisions (charge_key uuid PRIMARY KEY, status text NOT NULL);
GRANT ALL ON billing.character_free_chat_quota_decisions TO service_role;
CREATE TABLE test_fixture.finalize_calls (charge_key uuid NOT NULL, delivered boolean NOT NULL);
CREATE TABLE test_fixture.results (tag text PRIMARY KEY, out jsonb NOT NULL);
GRANT ALL ON test_fixture.finalize_calls, test_fixture.results TO service_role;
-- Stand-in for the production quota closer: records the call and releases the reservation.
CREATE FUNCTION billing.finalize_character_free_chat_round(p_charge_key uuid, p_delivered boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO test_fixture.finalize_calls VALUES (p_charge_key, p_delivered);
  UPDATE billing.character_free_chat_quota_decisions SET status = 'released' WHERE charge_key = p_charge_key;
END $$;
GRANT EXECUTE ON FUNCTION billing.finalize_character_free_chat_round(uuid, boolean) TO service_role;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
SET check_function_bodies = off; -- chat_first_token_report reads a view created below
CREATE FUNCTION experience.report_chat_first_token(p_user_id uuid, p_session_id uuid, p_report jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fx$
DECLARE r experience.chat_generation_requests%ROWTYPE; v_outcome text; v_reason text; v_charge_id uuid;
  v_v4 boolean := COALESCE(p_report->>'measurement_method'='client_committed_v4',false);
  v_delivery_failed boolean; v_lookup_ids uuid[]; v_history_id uuid;
BEGIN
  v_history_id := (p_report->>'assistant_message_id')::uuid;
  IF v_history_id IS NULL THEN
    -- Only a genuine unavailable v4 result may arrive before its SSE identity.
    IF NOT v_v4 OR NOT COALESCE((p_report->>'outcome') IN ('timed_out','not_observed'),false)
       OR p_report->>'revision' IS NOT NULL THEN RETURN false; END IF;
    -- Existing client_request_id index, at most two ownership-checked candidates.
    -- Replayed request identities are ambiguous; never guess a generation to bill.
    SELECT array_agg(candidate.chat_history_id) INTO v_lookup_ids FROM (
      SELECT r0.chat_history_id FROM experience.chat_generation_requests r0
      JOIN experience.chat_history h ON h.id=r0.chat_history_id
      WHERE r0.client_request_id=(p_report->>'request_id')::uuid
        AND h.user_id=p_user_id AND h.session_id=p_session_id LIMIT 2
    ) candidate;
    IF COALESCE(cardinality(v_lookup_ids),0)<>1 THEN RETURN false; END IF;
    v_history_id:=v_lookup_ids[1];
  END IF;
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0 JOIN experience.chat_history h ON h.id=r0.chat_history_id
  WHERE h.id=v_history_id AND h.user_id=p_user_id AND h.session_id=p_session_id
    AND (p_report->>'assistant_message_id' IS NULL OR h.revision=(p_report->>'revision')::integer)
    AND r0.client_request_id=(p_report->>'request_id')::uuid FOR UPDATE OF r0;
  IF NOT FOUND THEN RETURN false; END IF;
  -- A known v4 request cannot be downgraded by an old report. Legacy requests
  -- without an advertised method may still be served during rolling deployment.
  IF r.measurement_method='client_committed_v4' AND NOT v_v4 THEN RETURN false; END IF;
  -- v4 records one terminal observation. Replays do no UPDATE, even when recovery
  -- later delivers text; legacy v3's late-display behavior remains historical only.
  IF r.client_outcome <> 'missing' AND (v_v4 OR r.measurement_method='client_committed_v4'
      OR NOT (r.recoverable_delivery AND r.client_outcome <> 'observed' AND p_report->>'outcome'='observed')) THEN RETURN true; END IF;
  v_outcome := p_report->>'outcome';
  v_reason := p_report->>'reason';
  IF (v_v4 OR NOT r.recoverable_delivery) AND v_outcome='observed'
     AND (p_report->>'first_token_visible_ms')::numeric >= r.first_token_deadline_ms THEN
    v_outcome := 'timed_out';
    IF v_v4 THEN v_reason := 'not_visible'; END IF;
  END IF;
  -- server-facts-delivery-v1: a browser deadline stays a measurement. Only a relayed
  -- server failure marks delivery failed, which is what releases quota and waives billing.
  v_delivery_failed := COALESCE((r.recoverable_delivery AND (p_report->>'backgrounded')::boolean=false
    AND v_reason IN ('server_timeout','primary_timeout','fallback_timeout')),false);
  UPDATE experience.chat_generation_requests SET client_outcome=v_outcome,
    client_delivery_failed=client_delivery_failed OR v_delivery_failed,
    client_first_token_visible_ms=CASE WHEN v_outcome='observed' THEN (p_report->>'first_token_visible_ms')::numeric END,
    client_request_dispatched_ms=(p_report->>'request_dispatched_ms')::numeric,
    client_first_token_received_ms=(p_report->>'first_token_received_ms')::numeric,
    client_backgrounded=(p_report->>'backgrounded')::boolean,measurement_method=p_report->>'measurement_method',
    client_wait_finished_ms=(p_report->>'wait_finished_ms')::numeric,
    client_reason=v_reason,client_reported_at=clock_timestamp()
  WHERE chat_history_id=r.chat_history_id;
  -- Release a genuine cutoff's reservation in this same receipt transaction.
  -- Departure/background and explicit user stop do not become free cancellations.
  IF r.requires_visible_token AND v_outcome IN ('timed_out','not_observed')
    AND COALESCE(v_reason,'') <> 'cancelled'
    AND (NOT r.recoverable_delivery OR v_delivery_failed) THEN
    SELECT llm_charge_id INTO v_charge_id FROM experience.chat_history WHERE id=r.chat_history_id;
    IF EXISTS(SELECT 1 FROM billing.character_free_chat_quota_decisions
              WHERE charge_key=v_charge_id AND status='reserved') THEN
      PERFORM billing.finalize_character_free_chat_round(v_charge_id,false);
    END IF;
  END IF;
  RETURN true;
END;
$fx$;
CREATE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $fx$
DECLARE r experience.chat_generation_requests%ROWTYPE; h experience.chat_history%ROWTYPE;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0
  JOIN experience.chat_history h0 ON h0.id=r0.chat_history_id
  WHERE h0.llm_charge_id=p_charge_key FOR UPDATE OF r0;
  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
  IF r.recoverable_delivery THEN
    SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
    -- server-facts-delivery-v1: only a failure the server declared can waive a reply.
    -- client_delivery_failed now means a relayed server failure; older rows keep their waiver.
    IF r.client_delivery_failed OR r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
       OR h.llm_finish_reason='timeout'
      THEN RETURN 'waived'; END IF;
    IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
       AND h.llm_billing_snapshot->>'charge_id'=p_charge_key::text
       AND h.llm_billing_snapshot->>'billing_mode'='fixed_tier'
       AND jsonb_typeof(h.llm_billing_snapshot->'payable_credits')='number'
      THEN RETURN 'user_stopped'; END IF;
    IF r.client_outcome='missing' THEN
      IF clock_timestamp() >= r.request_received_at + make_interval(secs=>r.first_token_deadline_ms::double precision/1000+15) THEN RETURN 'waived'; END IF;
      RETURN 'pending';
    END IF;
    -- A durable complete reply belongs to the user even if they left before reading it.
    IF h.status='success' AND h.llm_finish_reason='stop' AND length(btrim(COALESCE(h.assistant_reply,'')))>0
       AND r.delivery_attempt_id IS NOT NULL AND r.server_first_token_ready_ms < r.first_token_deadline_ms
      THEN RETURN 'visible'; END IF;
    IF h.status <> 'streaming' THEN RETURN 'waived'; END IF;
    RETURN 'pending';
  END IF;
  -- A system cutoff cannot become chargeable through a competing stop click.
  IF r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
     OR r.client_outcome='timed_out'
     OR (r.client_outcome='not_observed' AND r.client_reason IN
       ('server_timeout','primary_timeout','fallback_timeout')) THEN RETURN 'waived'; END IF;
  SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
  IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
     AND h.llm_billing_snapshot->>'charge_id'=p_charge_key::text
     AND h.llm_billing_snapshot->>'billing_mode'='fixed_tier'
     AND jsonb_typeof(h.llm_billing_snapshot->'payable_credits')='number'
    THEN RETURN 'user_stopped'; END IF;
  IF r.client_outcome='observed' AND r.client_first_token_visible_ms IS NOT NULL
     AND r.client_first_token_visible_ms < r.first_token_deadline_ms THEN RETURN 'visible'; END IF;
  IF r.client_outcome IN ('timed_out','not_observed')
     OR clock_timestamp() >= r.request_received_at
       + make_interval(secs => r.first_token_deadline_ms::double precision / 1000 + 15)
    THEN RETURN 'waived'; END IF;
  RETURN 'pending';
END;
$fx$;
CREATE FUNCTION miniapp_analytics.chat_first_token_report(p_from timestamp with time zone, p_to timestamp with time zone) RETURNS SETOF jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $fx$
WITH facts AS (SELECT *, CASE WHEN measurement_method='client_committed_v4' THEN 'client_committed_v4' ELSE 'legacy' END AS measurement_cohort,
 (client_outcome='observed' AND (measurement_method IS DISTINCT FROM 'client_committed_v4' OR client_first_token_visible_ms < first_token_deadline_ms)) AS delivered,
 ((recoverable_delivery AND client_delivery_failed) OR (NOT recoverable_delivery AND client_outcome='timed_out') OR (client_outcome='not_observed' AND client_reason IN ('server_timeout','primary_timeout','fallback_timeout'))) AS time_cutoff FROM miniapp_analytics.chat_first_token_facts WHERE request_received_at >= p_from AND request_received_at < p_to AND p_to > p_from AND NOT billing_rejected),
totals AS (SELECT requested_model_id,measurement_cohort,count(*) AS model_requests FROM facts GROUP BY requested_model_id,measurement_cohort)
SELECT jsonb_build_object(
 'report_version',3,'from',p_from,'to',p_to,'model_id',f.requested_model_id,'provider',f.requested_provider,'provider_model_id',f.requested_provider_model_id,
 'fallback_model_id',f.fallback_model_id,'fallback_timeout_ms',f.fallback_timeout_ms,'measurement_method',f.measurement_method,
 'recoverable_delivery',f.recoverable_delivery,'catalog_version',f.catalog_version,'primary_timeout_ms',f.primary_timeout_ms,'first_token_deadline_ms',f.first_token_deadline_ms,
 'timeout_rate_target',f.timeout_rate_target,'model_requests',t.model_requests,'sample_eligible',t.model_requests>=150,
 'send_requests',count(*) FILTER(WHERE mode='send'),'regenerate_requests',count(*) FILTER(WHERE mode='regenerate'),
 'requests',count(*),'fallback_started',count(*) FILTER(WHERE fallback_started),'fallback_start_rate',avg(fallback_started::integer),
 'fallback_selected',count(*) FILTER(WHERE delivery_role='fallback'),'fallback_selection_rate',avg((COALESCE(delivery_role,'')='fallback')::integer),
 'fallback_displayed',count(*) FILTER(WHERE delivery_role='fallback' AND delivered),
 'fallback_display_share_observed',count(*) FILTER(WHERE delivery_role='fallback' AND delivered)::numeric/NULLIF(count(*) FILTER(WHERE delivered),0),
 'fallback_display_rate_lower_bound_all',count(*) FILTER(WHERE delivery_role='fallback' AND delivered)::numeric/NULLIF(count(*),0),
 'client_reports',count(*) FILTER(WHERE client_outcome<>'missing'),'client_report_coverage',avg((client_outcome<>'missing')::integer),
 'visible_samples',count(*) FILTER(WHERE delivered),'foreground_visible_samples',count(*) FILTER(WHERE delivered AND client_backgrounded=false),
 'user_first_token_p50_ms',percentile_cont(0.5) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND client_backgrounded=false),
 'user_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND client_backgrounded=false),
 'user_first_token_p95_ms',percentile_cont(0.95) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND client_backgrounded=false),
 'primary_display_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND delivery_role='primary' AND client_backgrounded=false),
 'fallback_display_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_first_token_visible_ms) FILTER(WHERE delivered AND delivery_role='fallback' AND client_backgrounded=false)
) || jsonb_build_object(
 'preparation_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_dispatch_offset_ms),
 'fallback_dispatch_delay_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_dispatch_delay_ms),
 'client_display_delay_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_display_delay_ms) FILTER(WHERE client_backgrounded=false),
 'primary_headers_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_headers_ms),
 'fallback_headers_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_headers_ms),
 'primary_provider_latency_samples',count(primary_provider_latency_ms),'fallback_provider_latency_samples',count(fallback_provider_latency_ms),
 'primary_provider_gap_samples',count(primary_provider_gap_ms),'fallback_provider_gap_samples',count(fallback_provider_gap_ms),
 'primary_wait_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_wait_ms),
 'fallback_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_first_token_ms),
 'primary_actual_first_token_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_actual_first_token_ms),
 'replaced_primary_later_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_actual_first_token_ms) FILTER(WHERE fallback_started),
 'primary_provider_gap_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY primary_provider_gap_ms),
 'fallback_provider_gap_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY fallback_provider_gap_ms),
 'client_server_residual_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_server_residual_ms) FILTER(WHERE client_backgrounded=false)
) || jsonb_build_object(
 'client_timeouts',count(*) FILTER(WHERE client_outcome='timed_out'),
 'client_timeout_rate_lower_bound_all',avg((client_outcome='timed_out')::integer),
 'foreground_timeout_rate_observed',count(*) FILTER(WHERE client_outcome='timed_out' AND client_backgrounded=false)::numeric / NULLIF(count(*) FILTER(WHERE client_outcome IN ('observed','timed_out') AND client_backgrounded=false),0),
 'foreground_deadline_samples',count(*) FILTER(WHERE client_outcome IN ('observed','timed_out') AND client_backgrounded=false),
 'backgrounded_requests',count(*) FILTER(WHERE client_backgrounded=true),
 'page_left_requests',count(*) FILTER(WHERE client_reason='page_left'),
 'client_upstream_errors_without_display',count(*) FILTER(WHERE client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')),
 'foreground_first_token_failure_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome='timed_out' OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout'))))::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),0),
 'foreground_time_cutoff_samples',count(*) FILTER(WHERE client_backgrounded=false AND time_cutoff),
 'foreground_known_result_samples',count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),
 'foreground_time_cutoff_rate_known',count(*) FILTER(WHERE client_backgrounded=false AND time_cutoff)::numeric / NULLIF(count(*) FILTER(WHERE client_backgrounded=false AND (client_outcome IN ('observed','timed_out') OR (client_outcome='not_observed' AND client_reason IN ('upstream_error','server_timeout','primary_timeout','fallback_timeout')))),0),
 'fallback_stage_failures',count(*) FILTER(WHERE server_timeout_stage='fallback'),
 'primary_stage_failures',count(*) FILTER(WHERE server_timeout_stage='primary'),
 'client_wait_finished_p90_ms',percentile_cont(0.9) WITHIN GROUP(ORDER BY client_wait_finished_ms) FILTER(WHERE client_backgrounded=false),
 'server_timeouts',count(*) FILTER(WHERE server_first_token_timeout),'missing_client_reports',count(*) FILTER(WHERE client_outcome='missing'),
 'not_observed',count(*) FILTER(WHERE client_outcome='not_observed'),'cancelled',count(*) FILTER(WHERE business_finish_reason='cancelled'),
 'failed',count(*) FILTER(WHERE business_status IN ('failed','upstream_error','stream_interrupted')),
 'primary_exact_samples',count(primary_actual_first_token_ms),'primary_censored_or_unknown',count(*) FILTER(WHERE primary_actual_first_token_ms IS NULL),
 'fallback_exact_samples',count(fallback_first_token_ms)
)
FROM facts f JOIN totals t USING(requested_model_id,measurement_cohort)
GROUP BY f.requested_model_id,f.requested_provider,f.requested_provider_model_id,f.catalog_version,f.fallback_model_id,f.primary_timeout_ms,f.first_token_deadline_ms,f.timeout_rate_target,f.fallback_timeout_ms,f.measurement_method,f.recoverable_delivery,t.model_requests;
$fx$;
CREATE FUNCTION experience.observe_chat_generation_attempt(p_history_id uuid, p_observation jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fx$
DECLARE a experience.chat_generation_attempts%ROWTYPE; v_discarded jsonb; v_input jsonb;
BEGIN
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=(p_observation->>'id')::uuid AND chat_history_id=p_history_id FOR UPDATE;
  IF a.provider IS DISTINCT FROM p_observation->>'provider' OR a.provider_model_id IS DISTINCT FROM p_observation->>'model' OR a.role IS DISTINCT FROM p_observation->>'role' THEN
    RAISE EXCEPTION 'Attempt route cannot be rebound' USING ERRCODE='22023';
  END IF;
  IF a.generation_id IS NOT NULL AND p_observation->>'generation_id' IS NOT NULL AND a.generation_id <> p_observation->>'generation_id' THEN
    RAISE EXCEPTION 'Attempt generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- A stopped loser is terminal. Replayed/later snapshots cannot overwrite or
  -- enlarge its diagnostic payload, and duplicate reports cause no UPDATE.
  IF a.discarded_response IS NOT NULL THEN RETURN; END IF;
  IF p_observation ? 'discarded_response' THEN
    v_input:=p_observation->'discarded_response';
    IF jsonb_typeof(v_input) IS DISTINCT FROM 'object'
       OR v_input->>'reason' IS DISTINCT FROM 'race_lost'
       OR jsonb_typeof(v_input->'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_input->'reasoning') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_input->'truncated') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid discarded attempt snapshot' USING ERRCODE='22023';
    END IF;
    -- Rebuild an explicit allowlist; never persist arbitrary provider objects.
    v_discarded:=jsonb_build_object('reason','race_lost',
      'content',left(v_input->>'content',2048),'reasoning',left(v_input->>'reasoning',2048),
      'truncated',(v_input->>'truncated')::boolean OR length(v_input->>'content')>2048 OR length(v_input->>'reasoning')>2048);
  END IF;
  UPDATE experience.chat_generation_attempts SET
    generation_id=COALESCE(generation_id,p_observation->>'generation_id'),
    dispatched_at=COALESCE(dispatched_at,(p_observation->>'dispatched_at')::timestamptz),
    dispatch_offset_ms=COALESCE(dispatch_offset_ms,(p_observation->>'dispatch_offset_ms')::numeric),
    headers_ms=COALESCE(headers_ms,(p_observation->>'headers_ms')::numeric),
    first_chunk_ms=COALESCE(first_chunk_ms,(p_observation->>'first_chunk_ms')::numeric),
    first_token_ms=COALESCE(first_token_ms,(p_observation->>'first_token_ms')::numeric),
    observed_until_ms=GREATEST(observed_until_ms,(p_observation->>'observed_until_ms')::numeric),
    http_status=COALESCE(http_status,(p_observation->>'http_status')::integer),
    end_reason=CASE WHEN v_discarded IS NOT NULL THEN 'cancelled' ELSE COALESCE(end_reason,p_observation->>'end_reason') END,
    discarded_response=v_discarded,
    provider_latency_ms=COALESCE(provider_latency_ms,(p_observation->>'provider_latency_ms')::numeric),
    provider_name=COALESCE(provider_name,left(p_observation->>'provider_name',512)),
    provider_reported_model=COALESCE(provider_reported_model,left(p_observation->>'provider_reported_model',512)),
    finish_reason=COALESCE(finish_reason,left(p_observation->>'finish_reason',128)),updated_at=clock_timestamp()
  WHERE id=a.id;
END;
$fx$;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE VIEW miniapp_analytics.chat_first_token_facts WITH (security_invoker = false) AS
 SELECT r.chat_history_id,
    r.request_received_at,
    r.requested_model_id,
    r.requested_provider,
    r.requested_provider_model_id,
    r.catalog_version,
    r.client_reason,
    r.measurement_method,
    r.primary_timeout_ms,
    r.first_token_deadline_ms,
    r.timeout_rate_target,
    r.mode,
    (r.fallback_triggered_ms IS NOT NULL) AS fallback_started,
    d.role AS delivery_role,
    r.billing_rejected,
    r.first_token_timeout AS server_first_token_timeout,
    r.client_outcome,
    r.client_first_token_visible_ms,
    r.client_backgrounded,
    r.client_request_dispatched_ms,
    r.client_first_token_received_ms,
    r.first_token_emitted_ms,
        CASE
            WHEN (r.fallback_triggered_ms IS NOT NULL) THEN (r.fallback_triggered_ms - p.dispatch_offset_ms)
            ELSE p.first_token_ms
        END AS primary_wait_ms,
    (f.dispatch_offset_ms - r.fallback_triggered_ms) AS fallback_dispatch_delay_ms,
    p.dispatch_offset_ms AS primary_dispatch_offset_ms,
    p.headers_ms AS primary_headers_ms,
    p.first_chunk_ms AS primary_first_chunk_ms,
    f.dispatch_offset_ms AS fallback_dispatch_offset_ms,
    f.headers_ms AS fallback_headers_ms,
    f.first_chunk_ms AS fallback_first_chunk_ms,
    p.provider_name AS primary_provider_name,
    f.provider_name AS fallback_provider_name,
    p.provider_reported_model AS primary_provider_reported_model,
    f.provider_reported_model AS fallback_provider_reported_model,
    p.provider_latency_scope AS primary_provider_latency_scope,
    f.provider_latency_scope AS fallback_provider_latency_scope,
    p.first_token_ms AS primary_actual_first_token_ms,
    f.first_token_ms AS fallback_first_token_ms,
    p.observed_until_ms AS primary_observed_until_ms,
    COALESCE(p.end_reason,
        CASE
            WHEN (p.dispatched_at IS NULL) THEN 'not_dispatched'::text
            WHEN (r.request_received_at < (statement_timestamp() - '00:01:50'::interval)) THEN 'unknown'::text
            ELSE 'pending'::text
        END) AS primary_end_reason,
    f.end_reason AS fallback_end_reason,
    p.provider_latency_ms AS primary_provider_latency_ms,
    f.provider_latency_ms AS fallback_provider_latency_ms,
    (p.first_token_ms - p.provider_latency_ms) AS primary_provider_gap_ms,
    (f.first_token_ms - f.provider_latency_ms) AS fallback_provider_gap_ms,
    (r.client_first_token_visible_ms - r.first_token_emitted_ms) AS client_server_residual_ms,
    (r.client_first_token_visible_ms - r.client_first_token_received_ms) AS client_display_delay_ms,
    h.status AS business_status,
    h.llm_finish_reason AS business_finish_reason,
    r.fallback_model_id,
    r.fallback_timeout_ms,
    r.client_wait_finished_ms,
    r.server_timeout_stage,
    r.recoverable_delivery,
    r.server_first_token_ready_ms,
    r.client_delivery_failed
   FROM ((((experience.chat_generation_requests r
     JOIN experience.chat_history h ON ((h.id = r.chat_history_id)))
     LEFT JOIN experience.chat_generation_attempts p ON (((p.chat_history_id = r.chat_history_id) AND (p.role = 'primary'::text))))
     LEFT JOIN experience.chat_generation_attempts f ON (((f.chat_history_id = r.chat_history_id) AND (f.role = 'fallback'::text))))
     LEFT JOIN experience.chat_generation_attempts d ON ((d.id = r.delivery_attempt_id)));
CREATE VIEW miniapp_analytics.free_zone_turn_facts AS
 SELECT f.chat_history_id,
    f.request_received_at AS turn_at,
    f.requested_model_id AS model_id,
    s.provider_name AS served_provider,
    (f.primary_actual_first_token_ms IS NOT NULL) AS primary_output,
    (f.delivery_role = 'fallback'::text) AS fallback_delivered,
    COALESCE(f.server_first_token_timeout, false) AS timed_out,
    f.primary_actual_first_token_ms AS primary_ttft_ms,
    (f.business_finish_reason = 'content_filter'::text) AS refused,
    (f.business_finish_reason = 'length'::text) AS truncated,
    (s.buyer_cost_micro / 1000000.0) AS buyer_cost_usd,
    s.prompt_tokens,
    s.cached_tokens,
    COALESCE((f.delivery_role = 'primary'::text), false) AS primary_delivered,
    COALESCE(((f.delivery_role = 'primary'::text) AND (f.business_status = 'stream_interrupted'::text) AND (COALESCE(f.business_finish_reason, ''::text) <> ALL (ARRAY['user_cancelled'::text, 'content_filter'::text]))), false) AS interrupted
   FROM (miniapp_analytics.chat_first_token_facts f
     LEFT JOIN experience.surplusintelligence_chat_history s ON ((s.chat_history_id = f.chat_history_id)))
  WHERE (f.requested_model_id ~~ 'free-%'::text);
GRANT SELECT ON miniapp_analytics.chat_first_token_facts, miniapp_analytics.free_zone_turn_facts TO service_role, first_token_metrics_reader;
GRANT EXECUTE ON FUNCTION miniapp_analytics.chat_first_token_report(timestamptz, timestamptz) TO service_role, first_token_metrics_reader;
GRANT EXECUTE ON FUNCTION experience.report_chat_first_token(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION billing.chat_delivery_billing_gate(uuid) TO service_role;

-- Deterministic ids per (set, tag).
CREATE FUNCTION test_fixture.id(p_kind text, p_set text, p_tag text) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $$ SELECT md5(p_kind || ':' || p_set || ':' || p_tag)::uuid $$;
GRANT EXECUTE ON FUNCTION test_fixture.id(text, text, text) TO service_role;
CREATE FUNCTION test_fixture.seed_turn(p_set text, p_tag text, p_age interval, p_model text, p_v4 boolean,
  p_recoverable boolean, p_quota boolean, p_status text DEFAULT 'success', p_finish text DEFAULT 'stop')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_h uuid := test_fixture.id('h', p_set, p_tag);
BEGIN
  INSERT INTO experience.chat_history(id, user_id, session_id, revision, status, llm_finish_reason, assistant_reply,
    llm_charge_id, llm_billing_snapshot, created_at)
  VALUES (v_h, test_fixture.id('u', 'all', 'user'), test_fixture.id('s', 'all', 'session'), 1, p_status, p_finish,
    'reply', test_fixture.id('c', p_set, p_tag),
    jsonb_build_object('charge_id', test_fixture.id('c', p_set, p_tag), 'billing_mode', 'fixed_tier', 'payable_credits', 2),
    now() - p_age);
  INSERT INTO experience.chat_generation_attempts(id, chat_history_id, role, provider, provider_model_id, generation_id,
    dispatched_at, dispatch_offset_ms, headers_ms, first_chunk_ms, first_token_ms, observed_until_ms, http_status,
    end_reason, provider_latency_ms, provider_name, provider_reported_model, finish_reason)
  VALUES (test_fixture.id('p', p_set, p_tag), v_h, 'primary', 'surplus', p_model, 'gen-p-' || p_tag, now() - p_age,
    120, 900, 1100, 1500, 9000, 200, 'first_token_observed', 1400, 'prov-a', p_model, 'stop');
  INSERT INTO experience.chat_generation_requests(chat_history_id, client_request_id, mode, request_received_at,
    requested_model_id, requested_provider, requested_provider_model_id, catalog_version, primary_timeout_ms,
    first_token_deadline_ms, timeout_rate_target, fallback_model_id, fallback_timeout_ms, recoverable_delivery,
    measurement_method, delivery_attempt_id, server_first_token_ready_ms, created_at)
  VALUES (v_h, test_fixture.id('r', p_set, p_tag), 'send', now() - p_age, p_model, 'surplus', p_model, 7, 20000, 30000,
    0.05, 'deepseek/deepseek-v4.1-flash', 8000, p_recoverable, CASE WHEN p_v4 THEN 'client_committed_v4' END,
    test_fixture.id('p', p_set, p_tag), 1500, now() - p_age);
  IF p_quota THEN
    INSERT INTO billing.character_free_chat_quota_decisions VALUES (test_fixture.id('c', p_set, p_tag), 'reserved');
  END IF;
END $$;
SQL

# View rows (set "v"): settled 3h / 26h ago (inside / outside the migration fingerprint window) and 30 minutes ago.
"${admin_psql[@]}" >/dev/null <<'SQL'
SELECT test_fixture.seed_turn('v', 'plain', '3 hours', 'free-alpha', true, true, false);
SELECT test_fixture.seed_turn('v', 'fallback', '3 hours', 'free-alpha', true, true, false, 'stream_interrupted', 'error');
SELECT test_fixture.seed_turn('v', 'old', '26 hours', 'paid-beta', true, false, false);
SELECT test_fixture.seed_turn('v', 'recent', '30 minutes', 'free-gamma', true, true, false, 'success', 'length');
SELECT test_fixture.seed_turn('v', 'legacy', '3 hours', 'paid-beta', false, false, false, 'success', 'content_filter');
-- A fallback attempt that won delivery, client figures on every row, one Surplus detail row.
INSERT INTO experience.chat_generation_attempts(id, chat_history_id, role, provider, provider_model_id, dispatched_at,
  dispatch_offset_ms, headers_ms, first_chunk_ms, first_token_ms, observed_until_ms, end_reason, provider_latency_ms,
  provider_name)
SELECT test_fixture.id('f', 'v', 'fallback'), test_fixture.id('h', 'v', 'fallback'), 'fallback', 'openrouter',
  'deepseek/deepseek-v4.1-flash', now() - interval '3 hours', 9100, 9600, 9800, 10100, 30000, 'completed', 900, 'prov-b';
UPDATE experience.chat_generation_requests SET fallback_triggered_ms = 9000,
  delivery_attempt_id = test_fixture.id('f', 'v', 'fallback')
WHERE chat_history_id = test_fixture.id('h', 'v', 'fallback');
UPDATE experience.chat_generation_attempts SET end_reason = NULL, dispatched_at = NULL
WHERE id = test_fixture.id('p', 'v', 'old');
UPDATE experience.chat_generation_requests SET client_outcome = 'observed', client_first_token_visible_ms = 1800,
  client_first_token_received_ms = 1600, client_backgrounded = false, client_reason = NULL,
  client_reported_at = now(), first_token_emitted_ms = 1550, client_request_dispatched_ms = 30,
  client_wait_finished_ms = 1900
WHERE chat_history_id IN (SELECT id FROM experience.chat_history);
INSERT INTO experience.surplusintelligence_chat_history(chat_history_id, provider_name, buyer_cost_micro,
  prompt_tokens, cached_tokens)
VALUES (test_fixture.id('h', 'v', 'plain'), 'prov-a', 1234, 900, 300);
SQL

# ── 6a-1 is already in production: apply it first, then verify 6a-2a on top of it ──
"${admin_psql[@]}" <"$p6a1" >"$task_tmp/p6a1.log" 2>&1 || { cat "$task_tmp/p6a1.log"; exit 1; }
grep -q 'p6a1: report patched=t' "$task_tmp/p6a1.log" || { cat "$task_tmp/p6a1.log"; exit 1; }
echo "ok: 6a-1 applied as the starting shape"

# Observation scenarios: identical bare attempts for set "a" (before) and set "b" (after).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION test_fixture.seed_attempt(p_set text, p_tag text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_h uuid := test_fixture.id('h', p_set, p_tag);
BEGIN
  INSERT INTO experience.chat_history(id, user_id, session_id, revision, status, llm_charge_id, created_at)
  VALUES (v_h, test_fixture.id('u', 'all', 'user'), test_fixture.id('s', 'all', 'session'), 1, 'streaming',
    test_fixture.id('c', p_set, p_tag), now() - interval '10 minutes');
  INSERT INTO experience.chat_generation_requests(chat_history_id, client_request_id, mode, request_received_at,
    requested_model_id, requested_provider, requested_provider_model_id, catalog_version, primary_timeout_ms,
    first_token_deadline_ms, timeout_rate_target, fallback_timeout_ms)
  VALUES (v_h, test_fixture.id('r', p_set, p_tag), 'send', now() - interval '10 minutes', 'paid-beta', 'openrouter',
    'vendor/model', 7, 20000, 30000, 0.05, 8000);
  INSERT INTO experience.chat_generation_attempts(id, chat_history_id, role, provider, provider_model_id)
  VALUES (test_fixture.id('p', p_set, p_tag), v_h, 'primary', 'openrouter', 'vendor/model');
END $$;
CREATE TABLE test_fixture.obs_results (tag text PRIMARY KEY, out jsonb NOT NULL);
GRANT ALL ON test_fixture.obs_results TO service_role;
CREATE FUNCTION test_fixture.run_observations(p_set text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_tag text; v_obs jsonb; v_step int := 0; v_err text;
BEGIN
  FOR v_tag, v_obs IN VALUES
    -- Dropped column names are spelled indirectly so the migration's reference guard only sees real readers.
    ('full', jsonb_build_object('generation_id', 'g-full', 'dispatched_at', '2026-11-19T00:00:00Z', 'dispatch_offset_ms', 120,
      'head' || 'ers_ms', 900, 'first_' || 'chunk_ms', 1100, 'first_token_ms', 1500, 'observed_until_ms', 4000,
      'http_' || 'status', 200, 'end_reason', 'first_token_observed', 'provider_' || 'latency_ms', 1400,
      'provider_' || 'name', 'Vendor A', 'provider_' || 'reported_model', 'vendor/model-x', 'finish_reason', 'stop')),
    ('full', jsonb_build_object('dispatch_offset_ms', 999, 'first_token_ms', 9999, 'observed_until_ms', 9000,
      'end_reason', 'completed', 'finish_reason', 'length')),
    ('slim', jsonb_build_object('generation_id', 'g-slim', 'dispatch_offset_ms', 80, 'first_token_ms', 700,
      'observed_until_ms', 2500, 'end_reason', 'completed', 'finish_reason', 'stop')),
    ('lost', jsonb_build_object('generation_id', 'g-lost', 'first_token_ms', 3000, 'observed_until_ms', 3100,
      'discarded_response', jsonb_build_object('reason', 'race_lost', 'content', 'partial', 'reasoning', '', 'truncated', false))),
    ('lost', jsonb_build_object('first_token_ms', 1, 'observed_until_ms', 99999, 'end_reason', 'completed')),
    ('conflict', jsonb_build_object('generation_id', 'g-one')),
    ('conflict', jsonb_build_object('generation_id', 'g-two')),
    ('rebind', jsonb_build_object('provider', 'venice'))
  LOOP
    v_step := v_step + 1;
    v_err := NULL;
    BEGIN
      PERFORM experience.observe_chat_generation_attempt(test_fixture.id('h', p_set, v_tag),
        jsonb_build_object('id', test_fixture.id('p', p_set, v_tag), 'role', 'primary', 'provider', 'openrouter',
          'model', 'vendor/model') || v_obs);
    EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ':' || SQLERRM;
    END;
    INSERT INTO test_fixture.obs_results
    SELECT p_set || ':' || lpad(v_step::text, 2, '0') || ':' || v_tag,
      jsonb_build_object('err', v_err, 'row', (SELECT jsonb_build_object('generation_id', a.generation_id,
        'dispatched_at', a.dispatched_at, 'dispatch_offset_ms', a.dispatch_offset_ms, 'first_token_ms', a.first_token_ms,
        'observed_until_ms', a.observed_until_ms, 'end_reason', a.end_reason, 'finish_reason', a.finish_reason,
        'discarded_response', a.discarded_response)
        FROM experience.chat_generation_attempts a WHERE a.id = test_fixture.id('p', p_set, v_tag)));
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION test_fixture.run_observations(text) TO service_role;
GRANT EXECUTE ON FUNCTION experience.observe_chat_generation_attempt(uuid, jsonb) TO service_role;
SELECT test_fixture.seed_attempt(s, t) FROM unnest(ARRAY['a','b']) s, unnest(ARRAY['full','slim','lost','conflict','rebind']) t;
-- Seeding is done; the helper writes the old columns and would trip the migration's reference guard.
DROP FUNCTION test_fixture.seed_turn(text, text, interval, text, boolean, boolean, boolean, text, text);
SQL

check "fixture observe body is the production one" <<'SQL'
SELECT md5(prosrc) = 'e15ca5790d4976698f455cba6d97c9f0' FROM pg_proc
WHERE oid = 'experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure;
SQL

"${admin_psql[@]}" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT test_fixture.run_observations('a');
RESET ROLE;
CREATE TABLE test_fixture.facts_before AS
SELECT chat_history_id, request_received_at, requested_model_id, requested_provider, requested_provider_model_id,
  catalog_version, client_reason, measurement_method, primary_timeout_ms, first_token_deadline_ms, timeout_rate_target,
  mode, fallback_started, delivery_role, billing_rejected, server_first_token_timeout, client_outcome,
  client_first_token_visible_ms, primary_wait_ms, fallback_dispatch_delay_ms, primary_dispatch_offset_ms,
  fallback_dispatch_offset_ms, primary_actual_first_token_ms, fallback_first_token_ms, primary_observed_until_ms,
  primary_end_reason, fallback_end_reason, business_status, business_finish_reason, fallback_model_id,
  fallback_timeout_ms, server_timeout_stage, recoverable_delivery, server_first_token_ready_ms, client_delivery_failed
FROM miniapp_analytics.chat_first_token_facts WHERE chat_history_id IN (
  SELECT test_fixture.id('h', 'v', t) FROM unnest(ARRAY['plain','fallback','old','recent','legacy']) t);
CREATE TABLE test_fixture.turns_before AS SELECT * FROM miniapp_analytics.free_zone_turn_facts;
SQL
check "before: observe keeps first values, a race loser is terminal, conflicts and rebinds are refused" <<'SQL'
SELECT count(*) = 8
  AND (SELECT (out->'row'->>'first_token_ms')::numeric = 1500 AND (out->'row'->>'observed_until_ms')::numeric = 9000
       AND out->'row'->>'finish_reason' = 'stop' FROM test_fixture.obs_results WHERE tag = 'a:02:full')
  AND (SELECT out->'row'->>'end_reason' = 'cancelled' AND (out->'row'->>'observed_until_ms')::numeric = 3100
       FROM test_fixture.obs_results WHERE tag = 'a:05:lost')
  AND (SELECT out->>'err' LIKE '22023:%' FROM test_fixture.obs_results WHERE tag = 'a:07:conflict')
  AND (SELECT out->>'err' LIKE '22023:%' FROM test_fixture.obs_results WHERE tag = 'a:08:rebind')
FROM test_fixture.obs_results WHERE tag LIKE 'a:%';
SQL
check "before: the old observe still writes the provider columns" <<'SQL'
SELECT headers_ms = 900 AND http_status = 200 AND provider_name = 'Vendor A' AND provider_reported_model = 'vendor/model-x'
FROM experience.chat_generation_attempts WHERE id = test_fixture.id('p', 'a', 'full');
SQL

# ── refusals: one drifted observe anchor; an unknown view over attempts ──
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  EXECUTE replace(pg_get_functiondef('experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure),
    'http_status=COALESCE(http_status,(p_observation->>''http_status'')::integer)',
    'http_status=COALESCE((p_observation->>''http_status'')::integer,http_status)');
END $$;
SQL
if apply >"$task_tmp/refuse1.log" 2>&1; then echo "FAIL: migration accepted a drifted observe function"; exit 1; fi
grep -q 'p6a2a: observe_chat_generation_attempt drifted (2 of 3 anchors found)' "$task_tmp/refuse1.log" || { cat "$task_tmp/refuse1.log"; exit 1; }
echo "ok: refuses a drifted observe function"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  EXECUTE replace(pg_get_functiondef('experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure),
    'http_status=COALESCE((p_observation->>''http_status'')::integer,http_status)',
    'http_status=COALESCE(http_status,(p_observation->>''http_status'')::integer)');
END $$;
CREATE VIEW test_fixture.attempt_reader AS SELECT id, headers_ms FROM experience.chat_generation_attempts;
SQL
if apply >"$task_tmp/refuse2.log" 2>&1; then echo "FAIL: migration accepted an unknown view over attempts"; exit 1; fi
grep -q 'p6a2a: unexpected views over chat_generation_attempts: test_fixture.attempt_reader' "$task_tmp/refuse2.log" || { cat "$task_tmp/refuse2.log"; exit 1; }
echo "ok: refuses an unknown view over attempts"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP VIEW test_fixture.attempt_reader;
SQL
check "refusals changed nothing (observe restored, columns and view intact)" <<'SQL'
SELECT md5(prosrc) = 'e15ca5790d4976698f455cba6d97c9f0'
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'experience.chat_generation_attempts'::regclass
       AND attname IN ('headers_ms','first_chunk_ms','http_status','provider_latency_ms','provider_latency_scope',
         'provider_name','provider_reported_model') AND NOT attisdropped) = 7
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'miniapp_analytics.chat_first_token_facts'::regclass
       AND attnum > 0 AND NOT attisdropped) = 49
FROM pg_proc WHERE oid = 'experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure;
SQL

# ── apply ──
apply >"$task_tmp/apply.log" 2>&1 || { cat "$task_tmp/apply.log"; exit 1; }
grep -q 'p6a2a: observe patched=t, views rebuilt=t, columns dropped=t, fingerprint=3:' "$task_tmp/apply.log" ||
  { cat "$task_tmp/apply.log"; echo "FAIL: unexpected apply notice"; exit 1; }
echo "ok: applied ($(grep -o 'fingerprint=[^ ]*' "$task_tmp/apply.log"))"

"${admin_psql[@]}" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT test_fixture.run_observations('b');
RESET ROLE;
SQL

check "after: the seven attempt columns are gone, identity and kept timings remain" <<'SQL'
SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = 'experience.chat_generation_attempts'::regclass
        AND attname IN ('headers_ms','first_chunk_ms','http_status','provider_latency_ms','provider_latency_scope',
          'provider_name','provider_reported_model') AND NOT attisdropped) = 0
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'experience.chat_generation_attempts'::regclass
        AND attname IN ('generation_id','dispatched_at','dispatch_offset_ms','first_token_ms','observed_until_ms',
          'end_reason','finish_reason','discarded_response','updated_at') AND NOT attisdropped) = 9;
SQL
check "after: observations give identical results (kept columns, terminal loser, refusals)" <<'SQL'
SELECT count(*) = 8 AND bool_and(a.out = b.out)
FROM test_fixture.obs_results a JOIN test_fixture.obs_results b ON substr(a.tag, 3) = substr(b.tag, 3)
WHERE a.tag LIKE 'a:%' AND b.tag LIKE 'b:%';
SQL
check "after: chat_first_token_facts kept columns are row-for-row identical (35 columns)" <<'SQL'
WITH now_rows AS (
  SELECT chat_history_id, request_received_at, requested_model_id, requested_provider, requested_provider_model_id,
    catalog_version, client_reason, measurement_method, primary_timeout_ms, first_token_deadline_ms, timeout_rate_target,
    mode, fallback_started, delivery_role, billing_rejected, server_first_token_timeout, client_outcome,
    client_first_token_visible_ms, primary_wait_ms, fallback_dispatch_delay_ms, primary_dispatch_offset_ms,
    fallback_dispatch_offset_ms, primary_actual_first_token_ms, fallback_first_token_ms, primary_observed_until_ms,
    primary_end_reason, fallback_end_reason, business_status, business_finish_reason, fallback_model_id,
    fallback_timeout_ms, server_timeout_stage, recoverable_delivery, server_first_token_ready_ms, client_delivery_failed
  FROM miniapp_analytics.chat_first_token_facts WHERE chat_history_id IN (SELECT chat_history_id FROM test_fixture.facts_before))
SELECT (SELECT count(*) FROM test_fixture.facts_before) = 5
  AND NOT EXISTS (SELECT * FROM now_rows EXCEPT SELECT * FROM test_fixture.facts_before)
  AND NOT EXISTS (SELECT * FROM test_fixture.facts_before EXCEPT SELECT * FROM now_rows)
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid = 'miniapp_analytics.chat_first_token_facts'::regclass
       AND attnum > 0 AND NOT attisdropped) = 35;
SQL
check "after: free_zone_turn_facts is identical" <<'SQL'
SELECT (SELECT count(*) FROM test_fixture.turns_before) = 3
  AND NOT EXISTS (SELECT * FROM miniapp_analytics.free_zone_turn_facts
                  WHERE chat_history_id IN (SELECT chat_history_id FROM test_fixture.turns_before)
                  EXCEPT SELECT * FROM test_fixture.turns_before)
  AND NOT EXISTS (SELECT * FROM test_fixture.turns_before EXCEPT SELECT * FROM miniapp_analytics.free_zone_turn_facts);
SQL
check "after: grants and reloptions kept on both views; observe keeps its grant" <<'SQL'
SELECT has_table_privilege('service_role', 'miniapp_analytics.chat_first_token_facts', 'SELECT')
  AND has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.chat_first_token_facts', 'SELECT')
  AND has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.free_zone_turn_facts', 'SELECT')
  AND NOT has_table_privilege('anon', 'miniapp_analytics.chat_first_token_facts', 'SELECT')
  AND has_function_privilege('service_role', 'experience.observe_chat_generation_attempt(uuid,jsonb)', 'EXECUTE')
  AND (SELECT reloptions = ARRAY['security_invoker=false'] FROM pg_class
       WHERE oid = 'miniapp_analytics.chat_first_token_facts'::regclass);
SQL
check "after: the backend free-zone quality query still runs on the rebuilt view" <<'SQL'
WITH scope AS (
  SELECT * FROM unnest(ARRAY['free-alpha','free-gamma']::text[], ARRAY['1970-01-01','1970-01-01']::timestamptz[]) AS s(model_id, since)
), recent AS (
  SELECT c.* FROM miniapp_analytics.chat_first_token_facts c JOIN scope s ON s.model_id = c.requested_model_id
  WHERE c.request_received_at >= GREATEST(s.since, now() - make_interval(hours => 48))
), classified AS (
  SELECT requested_model_id AS model_id, delivery_role = 'primary' AS primary_delivered,
    COALESCE(delivery_role = 'primary' AND business_status = 'stream_interrupted'
      AND COALESCE(business_finish_reason, '') NOT IN ('user_cancelled', 'content_filter'), false) AS interrupted,
    COALESCE(delivery_role IS DISTINCT FROM 'primary' AND primary_end_reason IN ('upstream_error', 'stream_interrupted')
      AND primary_wait_ms IS NOT NULL AND primary_wait_ms + 50 >= COALESCE(primary_observed_until_ms, 0), false) AS error_fallback,
    business_finish_reason IS NOT DISTINCT FROM 'user_cancelled' AND NOT COALESCE(server_first_token_timeout, false) AS user_cancelled
  FROM recent)
SELECT count(*) = 2 FROM (SELECT model_id, count(*) FROM classified GROUP BY model_id) q;
SQL

apply >"$task_tmp/rerun.log" 2>&1 || { cat "$task_tmp/rerun.log"; exit 1; }
grep -q 'p6a2a: already applied, nothing to do' "$task_tmp/rerun.log" || { cat "$task_tmp/rerun.log"; exit 1; }
echo "ok: rerun is a no-op"
"${admin_psql[@]}" -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure" >"$task_tmp/md5.txt"
echo "info: patched observe_chat_generation_attempt md5 = $(cat "$task_tmp/md5.txt")"
echo "PASS: p6a2a attempt column cleanup"
