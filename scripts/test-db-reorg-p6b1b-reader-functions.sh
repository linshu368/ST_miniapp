#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261121_db_reorg_p6b1b_reader_functions.sql as a NON-superuser:
# - the fixture functions are the production originals (md5 of prosrc matches production);
# - after the switch the gate, the settlement scans, the metadata-gap scan and feedback return what they returned before,
#   except that a turn without a charge id leaves the settlement scan;
# - the switched functions follow billing.usage_charges (not chat_history) for quote and settlement;
# - rerun is a no-op; a drifted function and a quote that differs from chat_history are refused before any change.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261121_db_reorg_p6b1b_reader_functions.sql"
task_container="st-db-reorg-p6b1b-readers-${RANDOM}-$$"
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
DROP SCHEMA IF EXISTS experience, billing, ops CASCADE;
DROP TABLE IF EXISTS public.before_scans, public.before_gaps;
CREATE SCHEMA experience; CREATE SCHEMA billing; CREATE SCHEMA ops;
CREATE TABLE experience.chat_history (id uuid PRIMARY KEY, user_id uuid, model text, user_input text, assistant_reply text,
  character_id uuid, status text, deduction_rate numeric(14,1), created_at timestamptz NOT NULL DEFAULT now(), llm_finish_reason text,
  llm_charge_id uuid, session_id uuid, turn_index integer, revision integer, llm_billing_snapshot jsonb, llm_billing_settled_at timestamptz);
-- Columns exactly as in production (11-21).
CREATE TABLE experience.chat_generation_requests (chat_history_id uuid NOT NULL, client_request_id uuid NOT NULL, mode text NOT NULL,
  request_received_at timestamptz NOT NULL, requested_model_id text NOT NULL, requested_provider text NOT NULL,
  requested_provider_model_id text NOT NULL, catalog_version integer NOT NULL, primary_timeout_ms integer NOT NULL,
  first_token_deadline_ms integer NOT NULL, timeout_rate_target numeric NOT NULL, fallback_model_id text NOT NULL DEFAULT 'x',
  fallback_triggered_ms numeric, delivery_attempt_id uuid, first_token_timeout boolean NOT NULL DEFAULT false,
  billing_rejected boolean NOT NULL DEFAULT false, client_outcome text NOT NULL DEFAULT 'missing', client_first_token_visible_ms numeric,
  measurement_method text, client_reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), fallback_timeout_ms integer,
  server_timeout_stage text, requires_visible_token boolean NOT NULL DEFAULT true, user_stop_billing_enabled boolean NOT NULL DEFAULT true,
  recoverable_delivery boolean NOT NULL DEFAULT false, client_delivery_failed boolean NOT NULL DEFAULT false,
  server_first_token_ready_ms numeric, first_token_preview jsonb);
CREATE TABLE experience.chat_generation_attempts (id uuid NOT NULL, chat_history_id uuid NOT NULL, role text NOT NULL, provider text NOT NULL,
  provider_model_id text NOT NULL, generation_id text, dispatched_at timestamptz, dispatch_offset_ms numeric, first_token_ms numeric,
  observed_until_ms numeric, end_reason text, finish_reason text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE experience.chat_sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, character_id uuid NOT NULL, deleted_at timestamptz);
CREATE TABLE experience.chat_reply_feedback (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, session_id uuid NOT NULL,
  message_id uuid NOT NULL, edit_version integer NOT NULL, character_id uuid NOT NULL, turn_index integer NOT NULL, revision integer NOT NULL,
  is_inherited boolean NOT NULL, model_id text NOT NULL, provider text, provider_model_id text, user_input text NOT NULL,
  assistant_reply text NOT NULL, reasons text[] NOT NULL DEFAULT '{}'::text[], detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_branch_turns (session_id uuid, turn_index integer, source_history_id uuid);
-- Same columns the production view exposes to save_chat_reply_feedback (own turns + inherited branch turns).
CREATE VIEW experience.session_chat_history AS
  SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.character_id, h.status, h.session_id, h.turn_index, h.revision,
    false AS is_inherited, false AS assistant_deleted, 0 AS assistant_edit_version
  FROM experience.chat_history h
  UNION ALL
  SELECT h.id, s.user_id, h.model, h.user_input, h.assistant_reply, s.character_id, h.status, b.session_id, b.turn_index, h.revision,
    true, false, 0
  FROM experience.chat_branch_turns b JOIN experience.chat_sessions s ON s.id = b.session_id
  JOIN experience.chat_history h ON h.id = b.source_history_id;
CREATE TABLE ops.llm_calls (id uuid PRIMARY KEY, raw_usage jsonb, cost_usd numeric);
CREATE TABLE billing.usage_charges (id uuid PRIMARY KEY, quote jsonb NOT NULL DEFAULT '{}'::jsonb, settled_at timestamptz,
  charged_credits numeric(14,1));

-- A: charged, delivered by OpenRouter (metadata missing), stopped by the user, unsettled
-- B: quoted but failed before admission (charge id cleared), never delivered
-- C: Surplus, settled, success (feedback target, also inherited by branch session S2)
-- D: Surplus, unsettled, success
INSERT INTO experience.chat_sessions VALUES
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', NULL),
  ('00000000-0000-0000-0000-0000000005a2', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', NULL);
INSERT INTO experience.chat_history (id, user_id, model, user_input, assistant_reply, character_id, status, deduction_rate, created_at,
  llm_finish_reason, llm_charge_id, session_id, turn_index, revision, llm_billing_snapshot, llm_billing_settled_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'm/a', 'q', 'partial', '00000000-0000-0000-0000-0000000000c1',
   'stream_interrupted', 10, now() - interval '2 hours', 'user_cancelled', '00000000-0000-0000-0000-0000000001aa', '00000000-0000-0000-0000-0000000005a1', 1, 0,
   '{"charge_id":"00000000-0000-0000-0000-0000000001aa","billing_mode":"fixed_tier","payable_credits":10,"provider":"openrouter","provider_model_id":"m/a","discount_rate":null}', NULL),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e1', 'm/b', 'q', NULL, '00000000-0000-0000-0000-0000000000c1',
   'upstream_error', 0, now() - interval '2 hours', NULL, NULL, '00000000-0000-0000-0000-0000000005a1', 2, 0,
   '{"charge_id":"00000000-0000-0000-0000-0000000001bb","billing_mode":"fixed_tier","payable_credits":8}', NULL),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000e1', 's/c', 'q', 'full reply', '00000000-0000-0000-0000-0000000000c1',
   'success', 6, now() - interval '3 hours', 'stop', '00000000-0000-0000-0000-0000000001cc', '00000000-0000-0000-0000-0000000005a1', 3, 0,
   '{"charge_id":"00000000-0000-0000-0000-0000000001cc","billing_mode":"fixed_tier","payable_credits":6,"provider":"surplus","provider_model_id":"s/c-v2"}', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000e1', 's/d', 'q', 'reply', '00000000-0000-0000-0000-0000000000c1',
   'success', 6, now() - interval '90 minutes', 'stop', '00000000-0000-0000-0000-0000000001dd', '00000000-0000-0000-0000-0000000005a1', 4, 0,
   '{"charge_id":"00000000-0000-0000-0000-0000000001dd","billing_mode":"fixed_tier","payable_credits":6,"provider":"surplus","provider_model_id":"s/d"}', NULL);
INSERT INTO billing.usage_charges (id, quote, settled_at, charged_credits)
SELECT h.llm_charge_id, jsonb_build_object('snapshot', h.llm_billing_snapshot), h.llm_billing_settled_at, h.deduction_rate
FROM experience.chat_history h WHERE h.llm_charge_id IS NOT NULL;
INSERT INTO experience.chat_generation_requests (chat_history_id, client_request_id, mode, request_received_at, requested_model_id,
  requested_provider, requested_provider_model_id, catalog_version, primary_timeout_ms, first_token_deadline_ms, timeout_rate_target,
  delivery_attempt_id, client_outcome, client_first_token_visible_ms) VALUES
  ('00000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'chat', now() - interval '2 hours', 'a', 'openrouter', 'm/a', 1, 6000, 6000, 0.05,
   '00000000-0000-0000-0000-0000000002aa', 'observed', 900),
  ('00000000-0000-0000-0000-00000000000c', gen_random_uuid(), 'chat', now() - interval '3 hours', 'c', 'surplus', 's/c', 1, 6000, 6000, 0.05,
   '00000000-0000-0000-0000-0000000002cc', 'observed', 900),
  ('00000000-0000-0000-0000-00000000000d', gen_random_uuid(), 'chat', now() - interval '90 minutes', 'd', 'surplus', 's/d', 1, 6000, 6000, 0.05,
   '00000000-0000-0000-0000-0000000002dd', 'observed', 900);
INSERT INTO experience.chat_generation_attempts (id, chat_history_id, role, provider, provider_model_id, generation_id) VALUES
  ('00000000-0000-0000-0000-0000000002aa', '00000000-0000-0000-0000-00000000000a', 'primary', 'openrouter', 'm/a', 'gen-a'),
  ('00000000-0000-0000-0000-0000000002cc', '00000000-0000-0000-0000-00000000000c', 'primary', 'surplus', 's/c-v2', 'sur-c'),
  ('00000000-0000-0000-0000-0000000002dd', '00000000-0000-0000-0000-00000000000d', 'primary', 'surplus', 's/d', 'sur-d');
INSERT INTO experience.chat_branch_turns VALUES ('00000000-0000-0000-0000-0000000005a2', 1, '00000000-0000-0000-0000-00000000000c');
SQL
  psql_f >/dev/null <<'ORIGINAL_DEFS'
CREATE OR REPLACE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION experience.list_chat_settlement_candidates(p_scan text, p_since timestamp with time zone, p_limit integer, p_identity_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamp with time zone, delivery_provider text, generation_id text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  WHERE h.created_at >= p_since
    AND h.llm_billing_snapshot IS NOT NULL
    AND h.llm_billing_settled_at IS NULL
    AND CASE
      WHEN p_scan IN ('openrouter', 'venice') THEN
        h.status <> 'streaming' AND a.provider = p_scan AND a.generation_id IS NOT NULL
      WHEN p_scan = 'surplus' THEN
        h.status <> 'streaming' AND h.llm_billing_snapshot ->> 'provider' = 'surplus'
      WHEN p_scan = 'missing_identity' THEN
        a.generation_id IS NULL AND h.created_at < p_identity_before
      ELSE false
    END
  ORDER BY h.created_at, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$function$;
CREATE OR REPLACE FUNCTION experience.list_llm_call_metadata_gaps(p_since timestamp with time zone, p_limit integer)
 RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamp with time zone, delivery_provider text, generation_id text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  -- db reorg 6a-2c-3: a gap is a missing cost or usage. finish_reason / latency / generation_time are optional
  -- (OpenRouter never returns them for some generations), so they no longer keep a turn in the scan forever.
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
    AND (l.id IS NULL OR l.raw_usage IS NULL OR l.cost_usd IS NULL)
  ORDER BY h.created_at DESC, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$function$;
CREATE OR REPLACE FUNCTION experience.save_chat_reply_feedback(p_user_id uuid, p_session_id uuid, p_message_id uuid, p_expected_version integer, p_reasons text[], p_detail text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET lock_timeout TO '3s'
 SET statement_timeout TO '5s'
AS $function$
DECLARE v_row record; v_feedback experience.chat_reply_feedback; v_reasons text[];
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_message_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0
  OR p_reasons IS NULL OR cardinality(p_reasons)>8 OR array_position(p_reasons,NULL) IS NOT NULL
  OR NOT(p_reasons <@ ARRAY['out_of_character','controls_player','lacks_tension','ignores_instructions','repetitive','dull_plot','slow_or_error','other']::text[])
  OR p_detail IS NULL OR char_length(p_detail)>500 THEN
  RAISE EXCEPTION 'invalid feedback input' USING ERRCODE='22023';
 END IF;
 SELECT COALESCE(array_agg(reason ORDER BY reason),'{}'::text[]) INTO v_reasons FROM (SELECT DISTINCT unnest(p_reasons) AS reason) t;
 PERFORM pg_advisory_xact_lock(hashtextextended('chat-feedback:'||p_user_id::text,0));
 -- Short owner lock serializes submissions and agrees with edit/regeneration locking.
 PERFORM 1 FROM experience.chat_sessions WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_feedback FROM experience.chat_reply_feedback WHERE session_id=p_session_id AND message_id=p_message_id AND edit_version=p_expected_version AND user_id=p_user_id;
 IF FOUND THEN
  -- Replay after a lost response keeps first evidence and timestamps stable.
  IF v_feedback.reasons IS DISTINCT FROM v_reasons OR v_feedback.detail IS DISTINCT FROM btrim(p_detail) THEN
   UPDATE experience.chat_reply_feedback SET reasons=v_reasons,detail=btrim(p_detail),updated_at=now()
   WHERE id=v_feedback.id RETURNING * INTO v_feedback;
  END IF;
 ELSE
  SELECT h.*,raw.llm_billing_snapshot INTO v_row
  FROM experience.session_chat_history h JOIN experience.chat_history raw ON raw.id=h.id
  WHERE h.session_id=p_session_id AND h.id=p_message_id AND h.user_id=p_user_id
    AND h.status='success' AND NOT h.assistant_deleted AND btrim(COALESCE(h.assistant_reply,''))<>''
    AND h.assistant_edit_version=p_expected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'reply changed or unavailable' USING ERRCODE='P0426'; END IF;
  IF (SELECT count(*) FROM experience.chat_reply_feedback WHERE user_id=p_user_id AND created_at>now()-interval '1 minute')>=30 THEN
   RAISE EXCEPTION 'too many feedback entries' USING ERRCODE='P0429';
  END IF;
  INSERT INTO experience.chat_reply_feedback(user_id,session_id,message_id,edit_version,character_id,turn_index,revision,is_inherited,
   model_id,provider,provider_model_id,user_input,assistant_reply,reasons,detail)
  VALUES(p_user_id,p_session_id,p_message_id,p_expected_version,v_row.character_id,v_row.turn_index,v_row.revision,v_row.is_inherited,
   v_row.model,v_row.llm_billing_snapshot->>'provider',v_row.llm_billing_snapshot->>'provider_model_id',v_row.user_input,v_row.assistant_reply,v_reasons,btrim(p_detail))
  RETURNING * INTO v_feedback;
 END IF;
 RETURN jsonb_build_object('feedback',jsonb_build_object('id',v_feedback.id,'session_id',v_feedback.session_id,'message_id',v_feedback.message_id,
  'edit_version',v_feedback.edit_version,'reasons',v_feedback.reasons,'detail',v_feedback.detail,'created_at',v_feedback.created_at,'updated_at',v_feedback.updated_at));
END $function$;
ORIGINAL_DEFS
}
scans() { # one row per scan result, comparable across runs
  cat <<'SQL'
SELECT s.scan, c.* FROM unnest(ARRAY['openrouter', 'venice', 'surplus', 'missing_identity']) AS s(scan)
CROSS JOIN LATERAL experience.list_chat_settlement_candidates(s.scan, now() - interval '1 day', 50, now()) c
SQL
}
feedback_provider() { # message id, session id
  psql_f -At <<SQL
SELECT experience.save_chat_reply_feedback('00000000-0000-0000-0000-0000000000e1', '$2', '$1', 0, ARRAY['dull_plot'], '') IS NOT NULL;
SELECT provider || '/' || provider_model_id FROM experience.chat_reply_feedback WHERE message_id = '$1' AND session_id = '$2';
DELETE FROM experience.chat_reply_feedback;
SQL
}

setup
check 'fixture functions are the production originals' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['9212526b76f7bbb588beca78a57525b8', '32f92b0952bf068801824dff36966815',
  '4d4e121b588cd14f67d3abcbe6b92d3e', 'bbff90fd7a7611f17817cac2c32f8f21']
FROM pg_proc WHERE proname IN ('chat_delivery_billing_gate', 'list_chat_settlement_candidates', 'list_llm_call_metadata_gaps', 'save_chat_reply_feedback');
SQL
psql_f >/dev/null <<SQL
CREATE TABLE public.before_scans AS $(scans);
CREATE TABLE public.before_gaps AS SELECT * FROM experience.list_llm_call_metadata_gaps(now() - interval '1 day', 50);
SQL
gate_before=$(psql_f -At -c "SELECT billing.chat_delivery_billing_gate('00000000-0000-0000-0000-0000000001aa')")
fb_own_before=$(feedback_provider 00000000-0000-0000-0000-00000000000c 00000000-0000-0000-0000-0000000005a1 | tail -1)
fb_inherited_before=$(feedback_provider 00000000-0000-0000-0000-00000000000c 00000000-0000-0000-0000-0000000005a2 | tail -1)
[[ "$gate_before" == 'user_stopped' && "$fb_own_before" == 'surplus/s/c-v2' && "$fb_inherited_before" == 'surplus/s/c-v2' ]] ||
  { echo "FAIL: baseline ($gate_before, $fb_own_before, $fb_inherited_before)"; exit 1; }
check 'baseline: the scans see A, B (no charge id) and D' <<'SQL'
SELECT (SELECT array_agg(scan || ':' || right(id::text, 1) ORDER BY scan, id) FROM public.before_scans)
  = ARRAY['missing_identity:b', 'openrouter:a', 'surplus:d']
  AND (SELECT count(*) FROM public.before_gaps) = 1;
SQL

out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'match usage_charges row by row'* && $(grep -c 'now reads usage_charges' <<<"$out") == 4 && "$out" == *'scans run'* ]] ||
  { echo "FAIL: apply: $out"; exit 1; }
echo 'ok: applied (4 functions switched)'
psql_f >/dev/null <<SQL
CREATE TABLE public.after_scans AS $(scans);
SQL
check 'settlement scans return the same rows except the turn without a charge id' <<'SQL'
SELECT NOT EXISTS (SELECT * FROM public.before_scans WHERE llm_charge_id IS NOT NULL EXCEPT ALL SELECT * FROM public.after_scans)
   AND NOT EXISTS (SELECT * FROM public.after_scans EXCEPT ALL SELECT * FROM public.before_scans WHERE llm_charge_id IS NOT NULL)
   AND (SELECT count(*) FROM public.after_scans) = 2;
SQL
check 'metadata-gap scan returns the same rows' <<'SQL'
SELECT NOT EXISTS (SELECT * FROM public.before_gaps EXCEPT ALL SELECT * FROM experience.list_llm_call_metadata_gaps(now() - interval '1 day', 50))
   AND NOT EXISTS (SELECT * FROM experience.list_llm_call_metadata_gaps(now() - interval '1 day', 50) EXCEPT ALL SELECT * FROM public.before_gaps);
SQL
[[ $(psql_f -At -c "SELECT billing.chat_delivery_billing_gate('00000000-0000-0000-0000-0000000001aa')") == 'user_stopped' ]] ||
  { echo 'FAIL: gate changed'; exit 1; }
echo 'ok: gate returns the same verdict'
[[ $(feedback_provider 00000000-0000-0000-0000-00000000000c 00000000-0000-0000-0000-0000000005a1 | tail -1) == "$fb_own_before" &&
   $(feedback_provider 00000000-0000-0000-0000-00000000000c 00000000-0000-0000-0000-0000000005a2 | tail -1) == "$fb_inherited_before" ]] ||
  { echo 'FAIL: feedback provider changed'; exit 1; }
echo 'ok: feedback records the same provider (own and inherited turn)'
check 'switched functions follow usage_charges, not chat_history' <<'SQL'
UPDATE billing.usage_charges SET quote = jsonb_set(quote, '{snapshot,billing_mode}', '"usage"') WHERE id = '00000000-0000-0000-0000-0000000001aa';
UPDATE billing.usage_charges SET settled_at = now() WHERE id = '00000000-0000-0000-0000-0000000001dd';
UPDATE billing.usage_charges SET quote = jsonb_set(quote, '{snapshot,provider_model_id}', '"s/c-v3"') WHERE id = '00000000-0000-0000-0000-0000000001cc';
SELECT experience.save_chat_reply_feedback('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000005a1',
  '00000000-0000-0000-0000-00000000000c', 0, ARRAY['other'], '') \gset
SELECT billing.chat_delivery_billing_gate('00000000-0000-0000-0000-0000000001aa') <> 'user_stopped'
   AND NOT EXISTS (SELECT 1 FROM experience.list_chat_settlement_candidates('surplus', now() - interval '1 day', 50))
   AND (SELECT provider_model_id FROM experience.chat_reply_feedback) = 's/c-v3';
SQL
psql_f -c "UPDATE billing.usage_charges u SET quote = jsonb_build_object('snapshot', h.llm_billing_snapshot), settled_at = h.llm_billing_settled_at FROM experience.chat_history h WHERE h.llm_charge_id = u.id" >/dev/null
out=$(psql_f <"$migration" 2>&1)
[[ $(grep -c 'already reads usage_charges' <<<"$out") == 4 ]] || { echo "FAIL: rerun: $out"; exit 1; }
echo 'ok: rerun is a no-op'

setup
psql_f -c "CREATE OR REPLACE FUNCTION experience.list_llm_call_metadata_gaps(p_since timestamptz, p_limit integer) RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamptz, delivery_provider text, generation_id text) LANGUAGE sql STABLE AS \$\$ SELECT NULL::uuid, NULL::uuid, NULL, NULL::uuid, NULL, NULL::uuid, NULL, NULL, NULL::jsonb, NULL::timestamptz, NULL, NULL WHERE false \$\$" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: drift should refuse"; exit 1; fi
[[ "$out" == *'list_llm_call_metadata_gaps'*'drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'a drifted function rolls the whole switch back' <<'SQL'
SELECT md5(prosrc) = '9212526b76f7bbb588beca78a57525b8' FROM pg_proc WHERE proname = 'chat_delivery_billing_gate';
SQL

setup
psql_f -c "UPDATE billing.usage_charges SET quote = '{\"snapshot\":{\"charge_id\":\"x\"}}' WHERE id = '00000000-0000-0000-0000-0000000001dd'" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: mismatch should refuse"; exit 1; fi
[[ "$out" == *'1 snapshots / 0 settled_at differ'* ]] || { echo "FAIL: guard message: $out"; exit 1; }
check 'a quote that differs from chat_history refuses before any change' <<'SQL'
SELECT md5(prosrc) = '9212526b76f7bbb588beca78a57525b8' FROM pg_proc WHERE proname = 'chat_delivery_billing_gate';
SQL
echo 'all checks passed'
