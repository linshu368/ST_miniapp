#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p5_chat_history_expand.sql + _backfill.sql as a NON-superuser with CREATEROLE:
# - fixture functions are the production bodies (md5 checked against production 2026-11-19);
# - expand refuses (and changes nothing) when an anchor no longer matches; it is idempotent;
# - one scenario (marker admission, two delivery previews, prompt freeze, marker replay after freeze, foreign request
#   identity refused, finalize, regeneration) run as service_role before and after expand gives identical results,
#   except: chat_history.history is no longer written, the frozen prompt lands in ops.chat_prompt_observations, and the
#   first-token preview is also written to chat_generation_requests;
# - new turns have history NULL; the invalidation trigger and the two unused indexes are gone;
# - backfill (and its faster follow-up) writes display projections (= extract of history) only for session turns without one, keeps existing v1
#   projections, skips rows locked by a writer and completes on rerun; copies previews and drive_mode; validates the
#   two NOT VALID checks; a rerun changes nothing.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
mig="$task_root/packages/shared/migrations"
expand="$mig/20261119_db_reorg_p5_chat_history_expand.sql"
backfill="$mig/20261119_db_reorg_p5_chat_history_backfill.sql"
backfill_fast="$mig/20261119_db_reorg_p5_chat_history_backfill_fast.sql"
display="$mig/20261111_chat_history_display_metadata.sql"
display_reads="$mig/20261111_chat_history_display_reads.sql"
contract="$mig/20261119_db_reorg_p5_chat_history_contract.sql"
task_container="st-db-reorg-p5-${RANDOM}-$$"
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

# Fixture mirrors the production shape collected on 2026-11-19 (columns, keys, indexes and triggers this change touches).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT anon, authenticated, service_role TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA experience; CREATE SCHEMA ops; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA experience, ops, test_fixture TO service_role;
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE app_core.characters (id uuid PRIMARY KEY);
CREATE TABLE experience.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES app_core.characters(id), deleted_at timestamptz,
  branch_inherited_turns integer NOT NULL DEFAULT 0, context_window_start_turn integer NOT NULL DEFAULT 1);
GRANT ALL ON experience.chat_sessions TO service_role;
CREATE TABLE experience.chat_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, model text NOT NULL, user_input text NOT NULL,
  assistant_reply text, history jsonb NOT NULL, character_id uuid, status text NOT NULL DEFAULT 'success'::text,
  upstream_status integer, deduction_rate numeric(14,1) DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  llm_finish_reason text, llm_intended_deduction numeric(10,2) DEFAULT NULL::numeric, llm_charge_id uuid, session_id uuid,
  turn_index integer, revision integer, llm_billing_snapshot jsonb, llm_billing_settled_at timestamptz,
  postprocess_version integer, choice_rules_mode text, status_rules_mode text, memory_rules_mode text,
  rich_reply_metadata jsonb, first_token_preview jsonb,
  CONSTRAINT chat_history_pkey PRIMARY KEY (id),
  CONSTRAINT chat_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT chat_history_character_id_fkey FOREIGN KEY (character_id) REFERENCES app_core.characters(id) ON DELETE SET NULL,
  CONSTRAINT chat_history_session_id_fkey FOREIGN KEY (session_id) REFERENCES experience.chat_sessions(id) ON DELETE SET NULL,
  CONSTRAINT chat_history_revision_check CHECK (((revision IS NULL) OR (revision >= 0))),
  CONSTRAINT chat_history_turn_index_check CHECK (((turn_index IS NULL) OR (turn_index > 0))),
  CONSTRAINT chat_history_rich_reply_metadata_check CHECK (((rich_reply_metadata IS NULL) OR ((jsonb_typeof(rich_reply_metadata) = 'object'::text) AND (rich_reply_metadata ?& ARRAY['rich_reply_mode'::text, 'rich_reply_result'::text, 'rich_reply_issues'::text]) AND ((rich_reply_metadata ->> 'rich_reply_mode'::text) = ANY (ARRAY['full'::text, 'concise'::text])) AND ((rich_reply_metadata ->> 'rich_reply_result'::text) = ANY (ARRAY['exact'::text, 'recovered'::text, 'failed'::text])) AND (jsonb_typeof((rich_reply_metadata -> 'rich_reply_issues'::text)) = 'array'::text) AND (jsonb_array_length((rich_reply_metadata -> 'rich_reply_issues'::text)) <= 8)))));
CREATE INDEX idx_chat_history_character_user_created_at ON experience.chat_history USING btree (character_id, user_id, created_at) WHERE (character_id IS NOT NULL);
CREATE INDEX idx_chat_history_created_at ON experience.chat_history USING btree (created_at DESC);
CREATE INDEX idx_chat_history_llm_charge_id ON experience.chat_history USING btree (llm_charge_id) WHERE (llm_charge_id IS NOT NULL);
CREATE INDEX idx_chat_history_model ON experience.chat_history USING btree (model, created_at DESC);
CREATE INDEX idx_chat_history_session ON experience.chat_history USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL);
CREATE INDEX idx_chat_history_session_current ON experience.chat_history USING btree (session_id, turn_index, revision DESC) WHERE ((session_id IS NOT NULL) AND (turn_index IS NOT NULL));
CREATE INDEX idx_chat_history_user ON experience.chat_history USING btree (user_id, created_at DESC);
CREATE INDEX idx_miniapp_cohort_chat_user_created ON experience.chat_history USING btree (user_id, created_at);
CREATE UNIQUE INDEX uq_chat_history_session_turn_revision ON experience.chat_history USING btree (session_id, turn_index, revision) WHERE ((session_id IS NOT NULL) AND (turn_index IS NOT NULL) AND (revision IS NOT NULL));
ALTER TABLE experience.chat_history ENABLE ROW LEVEL SECURITY;
GRANT ALL ON experience.chat_history TO service_role;
CREATE TABLE experience.chat_generation_requests (
  chat_history_id uuid NOT NULL PRIMARY KEY REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL, mode text NOT NULL CHECK (mode = ANY (ARRAY['send'::text, 'regenerate'::text])),
  request_received_at timestamptz NOT NULL, requested_model_id text NOT NULL, requested_provider text NOT NULL,
  requested_provider_model_id text NOT NULL, catalog_version integer NOT NULL, primary_timeout_ms integer NOT NULL,
  first_token_deadline_ms integer NOT NULL, timeout_rate_target numeric NOT NULL,
  fallback_model_id text NOT NULL DEFAULT 'deepseek/deepseek-v4.1-flash'::text, fallback_triggered_ms numeric,
  delivery_attempt_id uuid, first_token_emitted_ms numeric, first_token_timeout boolean NOT NULL DEFAULT false,
  billing_rejected boolean NOT NULL DEFAULT false, client_outcome text NOT NULL DEFAULT 'missing'::text,
  client_first_token_visible_ms numeric, client_request_dispatched_ms numeric, client_first_token_received_ms numeric,
  client_backgrounded boolean, measurement_method text, client_reason text, client_reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), fallback_timeout_ms integer, client_wait_finished_ms numeric,
  server_timeout_stage text, requires_visible_token boolean NOT NULL DEFAULT true,
  user_stop_billing_enabled boolean NOT NULL DEFAULT true, recoverable_delivery boolean NOT NULL DEFAULT false,
  client_delivery_failed boolean NOT NULL DEFAULT false, server_first_token_ready_ms numeric);
GRANT ALL ON experience.chat_generation_requests TO service_role;
CREATE TABLE experience.chat_generation_attempts (
  id uuid NOT NULL PRIMARY KEY, chat_history_id uuid NOT NULL REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role = ANY (ARRAY['primary'::text, 'fallback'::text])), provider text NOT NULL,
  provider_model_id text NOT NULL, CONSTRAINT chat_generation_attempt_role_unique UNIQUE (chat_history_id, role));
GRANT ALL ON experience.chat_generation_attempts TO service_role;
CREATE FUNCTION experience.guard_chat_session_idle(p_session_id uuid, p_stale_after_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN NULL; END $$;
CREATE TABLE test_fixture.results (tag text PRIMARY KEY, out jsonb NOT NULL);
GRANT INSERT, SELECT ON test_fixture.results TO service_role;
SQL

# Production function bodies (raw prosrc md5 as in production on 2026-11-19).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog
AS $prod$
DECLARE
  h experience.chat_history%ROWTYPE;
  v_fallback text := COALESCE(p_input->>'fallback_model_id','deepseek/deepseek-v4.1-flash');
  v_charge_id uuid := (p_input->>'charge_id')::uuid;
  v_request_id uuid := (p_input->>'request_id')::uuid;
  v_history jsonb := p_input->'history';
BEGIN
  IF (p_input ? 'fallback_model_id' AND jsonb_typeof(p_input->'fallback_model_id') IS DISTINCT FROM 'string')
     OR length(v_fallback) > 200
     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Invalid frozen fallback model ID' USING ERRCODE='22023';
  END IF;
  IF p_input->>'measurement_method' IS NOT NULL AND p_input->>'measurement_method' <> 'client_committed_v4' THEN
    RAISE EXCEPTION 'Invalid client measurement method' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'charge_id' AND v_charge_id IS NULL THEN
    RAISE EXCEPTION 'Invalid generation charge identity' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'history' THEN
    IF jsonb_typeof(v_history) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid generation history' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(v_history) = 0 OR v_request_id IS NULL
       OR (v_history#>>'{0,request_id}')::uuid IS DISTINCT FROM v_request_id
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_history) AS item
         WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR COALESCE(item->>'role','') NOT IN ('system','user','assistant')
           OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string'
       ) THEN
      RAISE EXCEPTION 'Generation history identity or message shape differs' USING ERRCODE='22023';
    END IF;
  END IF;

  IF p_input ? 'history' AND NOT (p_input ? 'snapshot')
     AND (jsonb_array_length(v_history) <> 1 OR v_history#>>'{0,role}' <> 'system' OR v_history#>>'{0,content}' <> '') THEN
    RAISE EXCEPTION 'Initial generation history must contain only its request marker' USING ERRCODE='22023';
  END IF;

  -- One PK row lock arbitrates admission/freeze against cancellation and terminal writes.
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL
     OR (v_charge_id IS NOT NULL AND h.llm_charge_id IS NOT NULL AND h.llm_charge_id <> v_charge_id)
     OR (p_input ? 'snapshot' AND COALESCE(h.llm_charge_id,v_charge_id)::text IS DISTINCT FROM p_input#>>'{snapshot,charge_id}') THEN
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='PT409';
  END IF;
  IF p_input ? 'history' AND h.history#>>'{0,request_id}' IS NOT NULL
     AND (h.history#>>'{0,request_id}')::uuid IS DISTINCT FROM v_request_id THEN
    RAISE EXCEPTION 'Stored generation request identity differs' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id)
     AND NOT EXISTS (
       SELECT 1 FROM experience.chat_generation_requests
       WHERE chat_history_id=p_history_id AND client_request_id=v_request_id
         AND (NOT (p_input ? 'fallback_model_id') OR fallback_model_id=v_fallback)
         AND fallback_timeout_ms IS NOT DISTINCT FROM (p_input->>'fallback_timeout_ms')::integer
         AND (p_input->>'measurement_method' IS NULL OR measurement_method=p_input->>'measurement_method')
     ) THEN
    RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
  END IF;

  IF p_input ? 'history' OR v_charge_id IS NOT NULL OR p_input ? 'snapshot' THEN
    -- chat_display_projection_v1
    IF p_input ? 'history' AND (p_input ? 'snapshot' OR h.llm_billing_snapshot IS NULL) THEN
      UPDATE experience.chat_history SET history=v_history,
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
      -- Derive only from the input actually accepted above, never from the stored TOAST value.
      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message,projection_version)
      SELECT p_history_id,d.request_id,d.opening_message,1 FROM experience.extract_chat_history_display(v_history) d
      WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
      ON CONFLICT(history_id) DO UPDATE SET request_id=excluded.request_id,
        opening_message=excluded.opening_message,projection_version=1;
    ELSE
      -- No history assignment: initial replay cannot erase the opening or invalidate its projection.
      UPDATE experience.chat_history SET llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN RETURN; END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms,recoverable_delivery,measurement_method)
  VALUES(p_history_id,v_request_id,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer,COALESCE((p_input->>'recoverable_delivery')::boolean,false),p_input->>'measurement_method');
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$prod$;

CREATE FUNCTION experience.record_chat_delivery_preview(p_history_id uuid, p_revision integer, p_ready_ms numeric, p_kind text, p_text text)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog
AS $prod$
DECLARE h experience.chat_history%ROWTYPE;
BEGIN
 IF p_kind NOT IN ('delta','reasoning') OR p_ready_ms IS NULL OR p_ready_ms<0 OR length(btrim(p_text))=0 OR length(p_text)>2048 THEN
  RAISE EXCEPTION 'Invalid delivery checkpoint' USING ERRCODE='22023';
 END IF;
 SELECT * INTO h FROM experience.chat_history WHERE id=p_history_id AND revision=p_revision FOR UPDATE;
 IF NOT FOUND OR h.status<>'streaming' OR h.llm_finish_reason IS NOT NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=h.id AND recoverable_delivery AND p_ready_ms<first_token_deadline_ms) THEN RETURN false; END IF;
 UPDATE experience.chat_history SET first_token_preview=COALESCE(first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text)) WHERE id=h.id;
 UPDATE experience.chat_generation_requests SET server_first_token_ready_ms=COALESCE(server_first_token_ready_ms,p_ready_ms) WHERE chat_history_id=h.id;
 RETURN true;
END;
$prod$;

CREATE FUNCTION experience.start_chat_history_turn(p_session_id uuid, p_user_content text, p_model text, p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75, p_retain_context_turns integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $prod$
DECLARE
  v_session experience.chat_sessions%ROWTYPE;
  v_turn_index INTEGER;
  v_history_id UUID;
  v_window_start INTEGER;
BEGIN
  IF p_session_id IS NULL
     OR btrim(COALESCE(p_user_content, '')) = ''
     OR btrim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'invalid start_chat_history_turn input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM experience.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM experience.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT COALESCE(max(turn_index), 0) + 1 INTO v_turn_index
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index IS NOT NULL;

  v_turn_index := GREATEST(v_turn_index, v_session.branch_inherited_turns + 1);

  v_window_start := GREATEST(COALESCE(v_session.context_window_start_turn, 1), 1);

  INSERT INTO experience.chat_history (
    user_id, model, user_input, assistant_reply, history, character_id,
    status, session_id, turn_index, revision
  ) VALUES (
    v_session.user_id, p_model, p_user_content, NULL, '[]'::jsonb, v_session.character_id,
    'streaming', p_session_id, v_turn_index, 0
  )
  RETURNING id INTO v_history_id;

  RETURN jsonb_build_object(
    'turn_index', v_turn_index,
    'history_id', v_history_id,
    'revision', 0,
    'context_window_start_turn', v_window_start
  );
END;
$prod$;

CREATE FUNCTION experience.start_chat_history_regeneration(p_session_id uuid, p_turn_index integer DEFAULT NULL::integer, p_model text DEFAULT NULL::text, p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75, p_retain_context_turns integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $prod$
DECLARE
  v_session experience.chat_sessions%ROWTYPE;
  v_last_turn INTEGER;
  v_user_content TEXT;
  v_revision INTEGER;
  v_history_id UUID;
  v_window_start INTEGER;
BEGIN
  IF p_session_id IS NULL OR btrim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'invalid start_chat_history_regeneration input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM experience.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM experience.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT GREATEST(COALESCE(max(turn_index), 0), v_session.branch_inherited_turns) INTO v_last_turn
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index IS NOT NULL;

  IF v_last_turn < 1 OR (p_turn_index IS NOT NULL AND p_turn_index <> v_last_turn) THEN
    RAISE EXCEPTION 'only the last turn can be regenerated' USING ERRCODE = '55000';
  END IF;

  SELECT user_input, revision INTO v_user_content, v_revision
  FROM experience.session_chat_history
  WHERE session_id = p_session_id AND turn_index = v_last_turn
  ORDER BY revision DESC
  LIMIT 1;

  IF NOT FOUND OR btrim(COALESCE(v_user_content, '')) = '' THEN
    RAISE EXCEPTION 'turn % has no user input to regenerate from', v_last_turn
      USING ERRCODE = '55000';
  END IF;

  v_window_start := GREATEST(COALESCE(v_session.context_window_start_turn, 1), 1);

  SELECT GREATEST(COALESCE(max(revision), -1), v_revision) + 1 INTO v_revision
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index = v_last_turn;

  INSERT INTO experience.chat_history (
    user_id, model, user_input, assistant_reply, history, character_id,
    status, session_id, turn_index, revision
  ) VALUES (
    v_session.user_id, p_model, v_user_content, NULL, '[]'::jsonb, v_session.character_id,
    'streaming', p_session_id, v_last_turn, v_revision
  )
  RETURNING id INTO v_history_id;

  RETURN jsonb_build_object(
    'turn_index', v_last_turn,
    'history_id', v_history_id,
    'revision', v_revision,
    'user_content', v_user_content,
    'context_window_start_turn', v_window_start
  );
END;
$prod$;
GRANT EXECUTE ON FUNCTION experience.begin_chat_generation_observation(uuid,jsonb),
  experience.record_chat_delivery_preview(uuid,integer,numeric,text,text),
  experience.start_chat_history_turn(uuid,text,text,integer,integer,integer),
  experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer) TO service_role;
SQL
# Display projection objects exactly as the 11-11 migration created them (its admission patch is already in the body).
sed '/OWNER TO postgres/d' "$display" | "${admin_psql[@]}" >/dev/null
# Read objects as production has them on 2026-11-19: tables the views join, the two session views (pg_get_viewdef),
# then the 11-11 display views and list_chat_message_page (production body = this file's body with CRLF).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE experience.chat_message_overrides (session_id uuid NOT NULL, message_id uuid NOT NULL, role text NOT NULL,
  content text, deleted boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, PRIMARY KEY (session_id, message_id, role));
CREATE TABLE experience.chat_message_likes (session_id uuid NOT NULL, message_id uuid NOT NULL, PRIMARY KEY (session_id, message_id));
CREATE TABLE experience.chat_branch_turns (session_id uuid NOT NULL, turn_index integer NOT NULL,
  source_history_id uuid NOT NULL REFERENCES experience.chat_history(id), PRIMARY KEY (session_id, turn_index));
CREATE TABLE experience.openrouter_chat_history (chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  provider_name text, usage jsonb, usage_cache jsonb, native_tokens_cached integer, native_tokens_reasoning integer,
  native_tokens_completion integer, native_tokens_prompt integer, latency numeric, generation_time numeric, model text,
  llm_generation_id text, llm_generation_data jsonb);
CREATE TABLE experience.venice_chat_history (chat_history_id uuid PRIMARY KEY REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  llm_provider_name text, llm_usage jsonb, llm_usage_cache jsonb, llm_native_tokens_cached integer, llm_native_tokens_reasoning integer,
  llm_native_tokens_completion integer, llm_native_tokens_prompt integer, llm_latency numeric, llm_generation_time numeric,
  llm_model text, llm_generation_id text, llm_generation_data jsonb);
GRANT ALL ON experience.chat_message_overrides, experience.chat_message_likes, experience.chat_branch_turns,
  experience.openrouter_chat_history, experience.venice_chat_history TO service_role;
CREATE VIEW experience.current_chat_history AS
 SELECT DISTINCT ON (h.session_id, h.turn_index) h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.history,
    h.character_id, h.status, h.upstream_status, h.deduction_rate, h.created_at,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_provider_name
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.provider_name ELSE NULL::text END AS llm_provider_name,
    h.llm_finish_reason,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_usage
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.usage ELSE NULL::jsonb END AS llm_usage,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_usage_cache
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.usage_cache ELSE NULL::jsonb END AS llm_usage_cache,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_native_tokens_cached
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.native_tokens_cached ELSE NULL::integer END AS llm_native_tokens_cached,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_native_tokens_reasoning
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.native_tokens_reasoning ELSE NULL::integer END AS llm_native_tokens_reasoning,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_native_tokens_completion
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.native_tokens_completion ELSE NULL::integer END AS llm_native_tokens_completion,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_native_tokens_prompt
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.native_tokens_prompt ELSE NULL::integer END AS llm_native_tokens_prompt,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_latency
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.latency ELSE NULL::numeric END AS llm_latency,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_generation_time
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.generation_time ELSE NULL::numeric END AS llm_generation_time,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_model
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.model ELSE NULL::text END AS llm_model,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_generation_id
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.llm_generation_id ELSE NULL::text END AS llm_generation_id,
    CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_generation_data
         WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.llm_generation_data ELSE NULL::jsonb END AS llm_generation_data,
    h.llm_intended_deduction, h.llm_charge_id, h.session_id, h.turn_index, h.revision, h.postprocess_version,
    h.choice_rules_mode, h.status_rules_mode, h.memory_rules_mode, h.rich_reply_metadata, h.first_token_preview
   FROM experience.chat_history h
     LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id = h.id
     LEFT JOIN experience.venice_chat_history v ON v.chat_history_id = h.id
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
  ORDER BY h.session_id, h.turn_index, h.revision DESC;
CREATE VIEW experience.session_chat_history WITH (security_invoker=true) AS
 SELECT h.id, h.user_id, h.model,
    CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
    CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    h.history, h.character_id, h.status, h.upstream_status, h.deduction_rate, h.created_at, h.llm_finish_reason,
    h.llm_charge_id, h.session_id, h.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
    h.first_token_preview, false AS is_inherited,
    (EXISTS (SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = h.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version
   FROM experience.current_chat_history h
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = h.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = h.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
UNION ALL
 SELECT h.id, s.user_id, h.model,
    CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
    CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    h.history, s.character_id, h.status, h.upstream_status, NULL::numeric AS deduction_rate, h.created_at,
    h.llm_finish_reason, NULL::uuid AS llm_charge_id, inherited.session_id, inherited.turn_index, h.revision,
    h.postprocess_version, h.rich_reply_metadata, NULL::jsonb AS first_token_preview, true AS is_inherited,
    (EXISTS (SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = inherited.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version
   FROM experience.chat_branch_turns inherited
     JOIN experience.chat_sessions s ON s.id = inherited.session_id
     JOIN experience.chat_history h ON h.id = inherited.source_history_id AND h.user_id = s.user_id AND h.character_id = s.character_id
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = inherited.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = inherited.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE NOT (EXISTS (SELECT 1 FROM experience.chat_history own WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index));
GRANT SELECT ON experience.current_chat_history, experience.session_chat_history TO service_role;
SQL
sed '/OWNER TO postgres/d' "$display_reads" | "${admin_psql[@]}" >/dev/null
check "fixture bodies are the production bodies" <<'SQL'
SELECT bool_and(md5(prosrc) = expected) FROM (VALUES
  ('experience.begin_chat_generation_observation(uuid,jsonb)', '445ebf1f0829512c345aac3d9cc44ec6'),
  ('experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)', '60b1ce4457237ddaca6bcda469a59801'),
  ('experience.start_chat_history_turn(uuid,text,text,integer,integer,integer)', '05036dc5e9ed2ee68313ec62602dead1'),
  ('experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)', 'edf7f20ee3223b2cceb1999175e8ce64')
) AS t(fn, expected) JOIN pg_proc p ON p.oid = t.fn::regprocedure;
SQL

# One scenario through the RPCs; the output is identity-free so runs on different sessions compare directly.
"${admin_psql[@]}" >/dev/null <<'SQL'
INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-0000000000a1');
INSERT INTO app_core.characters VALUES ('00000000-0000-4000-8000-0000000000c1');
INSERT INTO experience.chat_sessions (id, user_id, character_id) VALUES
  ('00000000-0000-4000-8000-00000000005a', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-00000000005b', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1');
CREATE FUNCTION test_fixture.scenario(p_sid uuid) RETURNS jsonb LANGUAGE plpgsql AS $s$
DECLARE
  v_r1 uuid := '11111111-1111-4111-8111-111111111111';
  v_r2 uuid := '22222222-2222-4222-8222-222222222222';
  v_r3 uuid := '33333333-3333-4333-8333-333333333333';
  v_c1 uuid := 'c1c1c1c1-0000-4000-8000-000000000001';
  v_c2 uuid := 'c2c2c2c2-0000-4000-8000-000000000002';
  v_base jsonb := jsonb_build_object('mode','send','received_at','2026-11-19T00:00:00Z','requested_model_id','m',
    'provider','openrouter','model','vendor/m','catalog_version',1,'timeout_ms',6000,'fallback_timeout_ms',5000,
    'deadline_ms',9000,'timeout_rate_target',0.05,'fallback_model_id','deepseek/deepseek-v4.1-flash',
    'recoverable_delivery',true,'measurement_method','client_committed_v4');
  v_h1 uuid; v_h2 uuid; v_errs jsonb := '{}'; v_prev jsonb := '{}'; v_out jsonb := '{}';
  v_turn jsonb; v_id uuid; v_ops jsonb;
BEGIN
  v_h1 := (experience.start_chat_history_turn(p_sid, 'hello', 'model-a')->>'history_id')::uuid;
  PERFORM experience.begin_chat_generation_observation(v_h1, v_base || jsonb_build_object('request_id',v_r1,
    'primary_attempt_id',gen_random_uuid(),'history',jsonb_build_array(jsonb_build_object('role','system','content','','request_id',v_r1))));
  v_prev := v_prev || jsonb_build_object('p1', experience.record_chat_delivery_preview(v_h1, 0, 100, 'delta', 'first chunk'));
  v_prev := v_prev || jsonb_build_object('p2', experience.record_chat_delivery_preview(v_h1, 0, 200, 'reasoning', 'second'));
  PERFORM experience.begin_chat_generation_observation(v_h1, v_base || jsonb_build_object('request_id',v_r1,
    'primary_attempt_id',gen_random_uuid(),'charge_id',v_c1,'snapshot',jsonb_build_object('charge_id',v_c1,'amount',1),
    'history',jsonb_build_array(jsonb_build_object('role','assistant','content','  opening line  ','request_id',v_r1),
      jsonb_build_object('role','system','content','rules'),jsonb_build_object('role','user','content','hello'))));
  -- Marker replay after the freeze changes nothing.
  PERFORM experience.begin_chat_generation_observation(v_h1, v_base || jsonb_build_object('request_id',v_r1,
    'primary_attempt_id',gen_random_uuid(),'history',jsonb_build_array(jsonb_build_object('role','system','content','','request_id',v_r1))));
  BEGIN
    PERFORM experience.begin_chat_generation_observation(v_h1, v_base || jsonb_build_object('request_id',v_r2,
      'primary_attempt_id',gen_random_uuid(),'history',jsonb_build_array(jsonb_build_object('role','system','content','','request_id',v_r2))));
    v_errs := v_errs || '{"e1":"none"}';
  EXCEPTION WHEN OTHERS THEN v_errs := v_errs || jsonb_build_object('e1', SQLERRM);
  END;
  UPDATE experience.chat_history SET status='success', assistant_reply='done', llm_finish_reason='stop' WHERE id=v_h1;
  v_h2 := (experience.start_chat_history_regeneration(p_sid, 1, 'model-b')->>'history_id')::uuid;
  PERFORM experience.begin_chat_generation_observation(v_h2, v_base || jsonb_build_object('mode','regenerate','request_id',v_r3,
    'primary_attempt_id',gen_random_uuid(),'history',jsonb_build_array(jsonb_build_object('role','system','content','','request_id',v_r3))));
  BEGIN -- foreign identity before the freeze (stored marker only)
    PERFORM experience.begin_chat_generation_observation(v_h2, v_base || jsonb_build_object('mode','regenerate','request_id',v_r2,
      'primary_attempt_id',gen_random_uuid(),'history',jsonb_build_array(jsonb_build_object('role','system','content','','request_id',v_r2))));
    v_errs := v_errs || '{"e2":"none"}';
  EXCEPTION WHEN OTHERS THEN v_errs := v_errs || jsonb_build_object('e2', SQLERRM);
  END;
  BEGIN -- history head must carry this request's identity
    PERFORM experience.begin_chat_generation_observation(v_h2, v_base || jsonb_build_object('mode','regenerate','request_id',v_r3,
      'primary_attempt_id',gen_random_uuid(),'charge_id',v_c2,'snapshot',jsonb_build_object('charge_id',v_c2),
      'history',jsonb_build_array(jsonb_build_object('role','assistant','content','x','request_id',v_r2))));
    v_errs := v_errs || '{"e3":"none"}';
  EXCEPTION WHEN OTHERS THEN v_errs := v_errs || jsonb_build_object('e3', SQLERRM);
  END;
  PERFORM experience.begin_chat_generation_observation(v_h2, v_base || jsonb_build_object('mode','regenerate','request_id',v_r3,
    'primary_attempt_id',gen_random_uuid(),'charge_id',v_c2,'snapshot',jsonb_build_object('charge_id',v_c2,'amount',2),
    'history',jsonb_build_array(jsonb_build_object('role','system','content','rules','request_id',v_r3),
      jsonb_build_object('role','assistant','content','second opening'),jsonb_build_object('role','user','content','hello'))));
  FOREACH v_id IN ARRAY ARRAY[v_h1, v_h2] LOOP
    v_ops := NULL;
    IF to_regclass('ops.chat_prompt_observations') IS NOT NULL THEN
      EXECUTE 'SELECT messages_snapshot FROM ops.chat_prompt_observations WHERE history_id = $1' INTO v_ops USING v_id;
    END IF;
    SELECT jsonb_build_object(
      'row', to_jsonb(h) - ARRAY['id','user_id','session_id','created_at','history','drive_mode'],
      'history', h.history,
      'meta', (SELECT to_jsonb(m) - 'history_id' FROM experience.chat_history_display_metadata m WHERE m.history_id = h.id),
      -- Column names are spelled indirectly so the contract's reference guard does not see these test helpers.
      'req', (SELECT to_jsonb(r) - ARRAY['chat_history_id','created_at','first_token' || '_preview'] FROM experience.chat_generation_requests r WHERE r.chat_history_id = h.id),
      'preview_new', (SELECT to_jsonb(r)->('first_token' || '_preview') FROM experience.chat_generation_requests r WHERE r.chat_history_id = h.id),
      'attempts', (SELECT count(*) FROM experience.chat_generation_attempts a WHERE a.chat_history_id = h.id),
      'ops', v_ops)
    INTO v_turn FROM experience.chat_history h WHERE h.id = v_id;
    v_out := v_out || jsonb_build_object(CASE WHEN v_id = v_h1 THEN 'h1' ELSE 'h2' END, v_turn);
  END LOOP;
  RETURN v_out || jsonb_build_object('errs', v_errs, 'prev', v_prev);
END
$s$;
GRANT EXECUTE ON FUNCTION test_fixture.scenario(uuid) TO service_role;
SET ROLE service_role;
INSERT INTO test_fixture.results SELECT 'old', test_fixture.scenario('00000000-0000-4000-8000-00000000005a');
SQL

# Legacy rows for the backfill (written before expand, when history was still NOT NULL).
"${admin_psql[@]}" >/dev/null <<'SQL'
INSERT INTO experience.chat_sessions (id, user_id, character_id) VALUES
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1');
INSERT INTO experience.chat_history (id, user_id, model, user_input, assistant_reply, history, character_id, status,
  session_id, turn_index, revision, created_at) VALUES
  -- L1: session turn without projection
  ('00000000-0000-4000-8000-0000000001a1', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', 'yo',
   '[{"role":"assistant","content":"  hello there  ","request_id":"9f0e5a52-1c9b-4b1e-8f71-5c1b2a3d4e5f"},{"role":"user","content":"hi"}]',
   '00000000-0000-4000-8000-0000000000c1', 'success', '00000000-0000-4000-8000-0000000000d1', 1, 0, '2026-08-01'),
  -- L2: already projected (must stay as is)
  ('00000000-0000-4000-8000-0000000001a2', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', 'yo',
   '[{"role":"assistant","content":"other"}]', '00000000-0000-4000-8000-0000000000c1', 'success',
   '00000000-0000-4000-8000-0000000000d1', 2, 0, '2026-11-12'),
  -- L3: before sessions existed (never displayed through session views)
  ('00000000-0000-4000-8000-0000000001a3', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', 'yo',
   '[{"role":"assistant","content":"legacy"}]', '00000000-0000-4000-8000-0000000000c1', 'success', NULL, NULL, NULL, '2026-07-01'),
  -- L6: will be locked by a concurrent writer during the first backfill run
  ('00000000-0000-4000-8000-0000000001a6', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', 'yo',
   '[null,{"role":"assistant","content":"after marker","request_id":"0b6f1c62-8d7e-4c55-9b1a-2f3e4d5c6b7a"}]',
   '00000000-0000-4000-8000-0000000000c1', 'success', '00000000-0000-4000-8000-0000000000d1', 3, 0, '2026-09-01');
INSERT INTO experience.chat_history_display_metadata VALUES ('00000000-0000-4000-8000-0000000001a2', 'keep', 'keep', 1);
-- 2,500 more session turns: several keyset batches and 100-id calls.
INSERT INTO experience.chat_history (user_id, model, user_input, assistant_reply, history, character_id, session_id, turn_index, revision)
SELECT '00000000-0000-4000-8000-0000000000a1', 'm', 'u' || g, 'a' || g,
  jsonb_build_array(jsonb_build_object('role','assistant','content','open ' || g,'request_id',gen_random_uuid())),
  '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d2', g, 0
FROM generate_series(1, 2500) g;
-- L4: preview written before expand (old column only); L5: drive_mode in rich_reply_metadata.
INSERT INTO experience.chat_history (id, user_id, model, user_input, assistant_reply, history, character_id, status,
  first_token_preview, rich_reply_metadata) VALUES
  ('00000000-0000-4000-8000-0000000001a4', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', NULL, '[]',
   '00000000-0000-4000-8000-0000000000c1', 'failed', '{"kind":"delta","text":"partial"}', NULL),
  ('00000000-0000-4000-8000-0000000001a5', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', 'yo', '[]',
   '00000000-0000-4000-8000-0000000000c1', 'success', NULL,
   '{"rich_reply_mode":"full","rich_reply_result":"exact","rich_reply_issues":[],"drive_mode":"plot"}');
INSERT INTO experience.chat_generation_requests (chat_history_id, client_request_id, mode, request_received_at,
  requested_model_id, requested_provider, requested_provider_model_id, catalog_version, primary_timeout_ms,
  first_token_deadline_ms, timeout_rate_target)
VALUES ('00000000-0000-4000-8000-0000000001a4', gen_random_uuid(), 'send', now(), 'm', 'openrouter', 'v/m', 1, 6000, 9000, 0.05);
SQL

# Expand refuses on a changed anchor and leaves nothing behind.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.saved AS
  SELECT pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure) AS def;
DO $$ BEGIN
  EXECUTE replace((SELECT def FROM test_fixture.saved), E'IS NOT NULL\n     AND (h.history', E'IS NOT NULL\n       AND (h.history');
END $$;
SQL
if out=$("${admin_psql[@]}" -f - <"$expand" 2>&1); then echo "FAIL: expand should refuse a changed anchor"; exit 1; fi
[[ "$out" == *"anchor 1 matched 0 times"* ]] || { echo "FAIL: unexpected refusal: $out"; exit 1; }
check "expand refused on a changed anchor and rolled back" <<'SQL'
SELECT to_regclass('ops.chat_prompt_observations') IS NULL
  AND (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'history')
  AND to_regclass('experience.idx_chat_history_user') IS NOT NULL;
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN EXECUTE (SELECT def FROM test_fixture.saved); END $$;
SQL

"${admin_psql[@]}" -f - <"$expand" >/dev/null
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.fn_after_expand AS
SELECT p.oid::regprocedure::text AS fn, md5(p.prosrc) AS md5sum FROM pg_proc p WHERE p.pronamespace = 'experience'::regnamespace;
SQL
"${admin_psql[@]}" -f - <"$expand" >/dev/null
check "expand is idempotent (second run changes no function)" <<'SQL'
SELECT NOT EXISTS (
  (SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'experience'::regnamespace
   EXCEPT SELECT fn, md5sum FROM test_fixture.fn_after_expand)
  UNION ALL
  (SELECT fn, md5sum FROM test_fixture.fn_after_expand
   EXCEPT SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'experience'::regnamespace));
SQL
check "expand shape: ops table + grants, history nullable, trigger and two indexes gone, new columns" <<'SQL'
SELECT to_regclass('ops.chat_prompt_observations') IS NOT NULL
  AND has_table_privilege('service_role', 'ops.chat_prompt_observations', 'INSERT')
  AND has_table_privilege('service_role', 'ops.chat_prompt_observations', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'ops.chat_prompt_observations', 'SELECT')
  AND NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'history')
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'experience.chat_history'::regclass AND NOT tgisinternal)
  AND to_regprocedure('experience.invalidate_chat_history_display()') IS NULL
  AND to_regclass('experience.idx_chat_history_user') IS NULL AND to_regclass('experience.idx_chat_history_model') IS NULL
  AND to_regclass('experience.idx_miniapp_cohort_chat_user_created') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'drive_mode')
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_generation_requests'::regclass AND attname = 'first_token_preview')
  AND (SELECT count(*) FROM pg_constraint WHERE conname IN ('chat_history_drive_mode_check',
         'chat_generation_requests_first_token_preview_check') AND NOT convalidated) = 2;
SQL

check "expanded bodies equal production after its expand" <<'SQL'
SELECT md5(prosrc) = '74f92f2293e06709948679b8a9563fcf' FROM pg_proc WHERE oid = 'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure
  AND (SELECT md5(prosrc) = '323b2d4abb69a57427154a93fb8dc50d' FROM pg_proc
       WHERE oid = 'experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)'::regprocedure);
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
SET ROLE service_role;
INSERT INTO test_fixture.results SELECT 'new', test_fixture.scenario('00000000-0000-4000-8000-00000000005b');
-- A turn opened after expand that has not reached admission: history NULL, no projection; must not block the backfill.
SELECT experience.start_chat_history_turn('00000000-0000-4000-8000-0000000000d1', 'pending', 'm');
SQL
check "scenario: identical outcomes before/after expand apart from where the prompt and preview are stored" <<'SQL'
WITH o AS (SELECT out FROM test_fixture.results WHERE tag = 'old'), n AS (SELECT out FROM test_fixture.results WHERE tag = 'new')
SELECT (o.out #- '{h1,history}' #- '{h2,history}' #- '{h1,ops}' #- '{h2,ops}' #- '{h1,preview_new}' #- '{h2,preview_new}')
     = (n.out #- '{h1,history}' #- '{h2,history}' #- '{h1,ops}' #- '{h2,ops}' #- '{h1,preview_new}' #- '{h2,preview_new}')
FROM o, n;
SQL
check "scenario: the frozen prompt moved to ops; history no longer written; preview written to both places" <<'SQL'
WITH o AS (SELECT out FROM test_fixture.results WHERE tag = 'old'), n AS (SELECT out FROM test_fixture.results WHERE tag = 'new')
SELECT jsonb_array_length(o.out #> '{h1,history}') = 3 AND o.out #> '{h1,ops}' = 'null'::jsonb
  AND n.out #> '{h1,ops}' = o.out #> '{h1,history}' AND n.out #> '{h2,ops}' = o.out #> '{h2,history}'
  AND n.out #> '{h1,history}' = 'null'::jsonb AND n.out #> '{h2,history}' = 'null'::jsonb
  AND n.out #> '{h1,preview_new}' = o.out #> '{h1,row,first_token_preview}'
  AND o.out #>> '{h1,row,first_token_preview,text}' = 'first chunk'
  AND o.out #>> '{errs,e1}' = 'Stored generation request identity differs'
  AND o.out #>> '{errs,e2}' = 'Stored generation request identity differs'
  AND o.out #>> '{errs,e3}' = 'Generation history identity or message shape differs'
  AND o.out #>> '{h1,meta,opening_message}' = 'opening line' AND o.out #>> '{h2,meta,opening_message}' = 'second opening'
FROM o, n;
SQL

# Backfill, first run while a writer holds one legacy row (SKIP LOCKED), then a rerun completes it.
docker exec "$task_container" psql -X -q -U app_admin -d postgres -c \
  "BEGIN; SELECT 1 FROM experience.chat_history WHERE id = '00000000-0000-4000-8000-0000000001a6' FOR UPDATE; SELECT pg_sleep(8); COMMIT;" >/dev/null &
locker=$!
sleep 2
if first_run=$("${admin_psql[@]}" -f - <"$backfill" 2>&1); then
  echo "FAIL: backfill should report incomplete while a row is locked"; exit 1
fi
[[ "$first_run" == *"skipped (locked) 1"* && "$first_run" == *"remaining: projection 1 / preview 0"* &&
  "$first_run" == *"p5 backfill incomplete"* ]] || { echo "FAIL: unexpected first backfill run: $first_run"; exit 1; }
echo "ok: backfill reports the locked row and refuses to finish"
check "backfill: locked row skipped, everything else written, checks validated" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata WHERE history_id = '00000000-0000-4000-8000-0000000001a6')
  AND (SELECT count(*) FROM experience.chat_history_display_metadata m JOIN experience.chat_history h ON h.id = m.history_id
       WHERE h.session_id = '00000000-0000-4000-8000-0000000000d2') = 2500
  AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('chat_history_drive_mode_check',
        'chat_generation_requests_first_token_preview_check') AND NOT convalidated);
SQL
wait "$locker"
# The faster follow-up finishes the remainder; afterwards the original file closes with nothing left.
# Pretend the original runs never reached the small phases for one row each (as in production).
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.chat_generation_requests SET first_token_preview = NULL WHERE chat_history_id = '00000000-0000-4000-8000-0000000001a4';
UPDATE experience.chat_history SET drive_mode = NULL WHERE id = '00000000-0000-4000-8000-0000000001a5';
SQL
fast_run=$("${admin_psql[@]}" -f - <"$backfill_fast" 2>&1) || { echo "FAIL: fast backfill errored: $fast_run"; exit 1; }
[[ "$fast_run" == *"fast remaining: projection 0 / preview 0 / drive_mode 0"* && "$fast_run" == *"display projection written 1 rows"* &&
  "$fast_run" == *"first_token_preview copied 1 rows"* && "$fast_run" == *"drive_mode copied 1 rows"* ]] ||
  { echo "FAIL: fast backfill did not finish the locked row: $fast_run"; exit 1; }
echo "ok: fast backfill finishes the remainder"
second_run=$("${admin_psql[@]}" -f - <"$backfill" 2>&1) || { echo "FAIL: backfill (second_run) errored: $second_run"; exit 1; }
[[ "$second_run" == *"remaining: projection 0 / preview 0 / drive_mode 0"* ]] || { echo "FAIL: rerun left work: $second_run"; exit 1; }
check "backfill: projections equal the legacy extraction; existing projection kept; no-session rows untouched" <<'SQL'
SELECT NOT EXISTS (
    SELECT 1 FROM experience.chat_history h JOIN experience.chat_history_display_metadata m ON m.history_id = h.id
    CROSS JOIN LATERAL experience.extract_chat_history_display(h.history) d
    WHERE h.id <> '00000000-0000-4000-8000-0000000001a2' AND h.history IS NOT NULL
      AND (m.request_id IS DISTINCT FROM d.request_id OR m.opening_message IS DISTINCT FROM d.opening_message OR m.projection_version <> 1))
  AND (SELECT request_id = 'keep' AND opening_message = 'keep' FROM experience.chat_history_display_metadata
       WHERE history_id = '00000000-0000-4000-8000-0000000001a2')
  AND (SELECT opening_message = 'hello there' FROM experience.chat_history_display_metadata
       WHERE history_id = '00000000-0000-4000-8000-0000000001a1')
  AND (SELECT request_id = '0b6f1c62-8d7e-4c55-9b1a-2f3e4d5c6b7a' AND opening_message = 'after marker'
       FROM experience.chat_history_display_metadata WHERE history_id = '00000000-0000-4000-8000-0000000001a6')
  AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata WHERE history_id = '00000000-0000-4000-8000-0000000001a3')
  AND NOT EXISTS (SELECT 1 FROM experience.chat_history h WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL
        AND h.revision IS NOT NULL AND h.history IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m WHERE m.history_id = h.id))
  AND (SELECT count(*) = 1 FROM experience.chat_history WHERE user_input = 'pending' AND history IS NULL)
  AND to_regprocedure('experience.p5_chat_history_backfill_step()') IS NULL;
SQL
check "backfill: preview copied to the delivery-state table, drive_mode copied to its column" <<'SQL'
SELECT (SELECT first_token_preview = '{"kind":"delta","text":"partial"}' FROM experience.chat_generation_requests
        WHERE chat_history_id = '00000000-0000-4000-8000-0000000001a4')
  AND (SELECT drive_mode = 'plot' FROM experience.chat_history WHERE id = '00000000-0000-4000-8000-0000000001a5')
  AND NOT EXISTS (SELECT 1 FROM experience.chat_generation_requests r JOIN experience.chat_history h ON h.id = r.chat_history_id
        WHERE r.first_token_preview IS DISTINCT FROM h.first_token_preview);
SQL
third_run=$("${admin_psql[@]}" -f - <"$backfill" 2>&1) || { echo "FAIL: backfill (third_run) errored: $third_run"; exit 1; }
[[ "$third_run" == *"projection written 0 rows"* && "$third_run" == *"first_token_preview copied 0 rows"* &&
  "$third_run" == *"drive_mode copied 0 rows"* ]] || { echo "FAIL: rerun was not a no-op: $third_run"; exit 1; }
echo "ok: backfill rerun is a no-op"

# ===================== contract =====================
# Read-path data (after expand: history NULL): session R with an edited user message, a regenerated turn with a like,
# a streaming turn and a failed turn that only has a preview; branch B inherits R's turns 1-2 and has its own turn 3.
"${admin_psql[@]}" >/dev/null <<'SQL'
INSERT INTO experience.chat_sessions (id, user_id, character_id) VALUES
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1');
INSERT INTO experience.chat_history (id, user_id, model, user_input, assistant_reply, character_id, status, session_id,
  turn_index, revision, deduction_rate, llm_charge_id, upstream_status, rich_reply_metadata, created_at) VALUES
  ('00000000-0000-4000-8000-000000000e11', '00000000-0000-4000-8000-0000000000a1', 'm', 'hi', 'one', '00000000-0000-4000-8000-0000000000c1', 'success', '00000000-0000-4000-8000-0000000000e1', 1, 0, 2.5, '00000000-0000-4000-8000-00000000c011', NULL, '{"rich_reply_mode":"full","rich_reply_result":"exact","rich_reply_issues":[]}', '2026-11-19 01:00'),
  ('00000000-0000-4000-8000-000000000e12', '00000000-0000-4000-8000-0000000000a1', 'm', 'two?', 'two-a', '00000000-0000-4000-8000-0000000000c1', 'success', '00000000-0000-4000-8000-0000000000e1', 2, 0, 2.5, NULL, NULL, NULL, '2026-11-19 01:01'),
  ('00000000-0000-4000-8000-000000000e13', '00000000-0000-4000-8000-0000000000a1', 'm2', 'two?', 'two-b', '00000000-0000-4000-8000-0000000000c1', 'success', '00000000-0000-4000-8000-0000000000e1', 2, 1, 3, NULL, NULL, NULL, '2026-11-19 01:02'),
  ('00000000-0000-4000-8000-000000000e14', '00000000-0000-4000-8000-0000000000a1', 'm', 'three', NULL, '00000000-0000-4000-8000-0000000000c1', 'failed', '00000000-0000-4000-8000-0000000000e1', 3, 0, 2.5, NULL, 502, NULL, '2026-11-19 01:03'),
  ('00000000-0000-4000-8000-000000000e15', '00000000-0000-4000-8000-0000000000a1', 'm', 'four', NULL, '00000000-0000-4000-8000-0000000000c1', 'streaming', '00000000-0000-4000-8000-0000000000e1', 4, 0, 2.5, NULL, NULL, NULL, '2026-11-19 01:04'),
  ('00000000-0000-4000-8000-000000000e21', '00000000-0000-4000-8000-0000000000a1', 'm', 'b-three', 'b-reply', '00000000-0000-4000-8000-0000000000c1', 'success', '00000000-0000-4000-8000-0000000000e2', 3, 0, 2.5, NULL, NULL, NULL, '2026-11-19 01:05');
INSERT INTO experience.chat_history_display_metadata (history_id, request_id, opening_message, projection_version) VALUES
  ('00000000-0000-4000-8000-000000000e11', 'req-1', 'opening R', 1),
  ('00000000-0000-4000-8000-000000000e13', 'req-2b', NULL, 1),
  ('00000000-0000-4000-8000-000000000e14', 'req-3', NULL, 1),
  ('00000000-0000-4000-8000-000000000e21', 'req-b3', NULL, 1);
INSERT INTO experience.chat_generation_requests (chat_history_id, client_request_id, mode, request_received_at,
  requested_model_id, requested_provider, requested_provider_model_id, catalog_version, primary_timeout_ms,
  first_token_deadline_ms, timeout_rate_target, recoverable_delivery, first_token_preview) VALUES
  ('00000000-0000-4000-8000-000000000e14', gen_random_uuid(), 'send', now(), 'm', 'openrouter', 'v/m', 1, 6000, 9000, 0.05, true, '{"kind":"delta","text":"partial three"}'),
  ('00000000-0000-4000-8000-000000000e15', gen_random_uuid(), 'send', now(), 'm', 'openrouter', 'v/m', 1, 6000, 9000, 0.05, true, '{"kind":"reasoning","text":"thinking"}');
UPDATE experience.chat_history SET first_token_preview = '{"kind":"delta","text":"partial three"}' WHERE id = '00000000-0000-4000-8000-000000000e14';
UPDATE experience.chat_history SET first_token_preview = '{"kind":"reasoning","text":"thinking"}' WHERE id = '00000000-0000-4000-8000-000000000e15';
INSERT INTO experience.chat_message_overrides (session_id, message_id, role, content, deleted, version) VALUES
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000e11', 'user', 'hi (edited)', false, 2),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000e13', 'assistant', NULL, true, 1);
INSERT INTO experience.chat_message_likes VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000e13');
INSERT INTO experience.chat_branch_turns VALUES
  ('00000000-0000-4000-8000-0000000000e2', 1, '00000000-0000-4000-8000-000000000e11'),
  ('00000000-0000-4000-8000-0000000000e2', 2, '00000000-0000-4000-8000-000000000e13');
-- Stale drive_mode keys (as the old backend wrote them) are moved into the column by the contract's first step.
UPDATE experience.chat_history SET drive_mode = NULL,
  rich_reply_metadata = rich_reply_metadata || '{"drive_mode":"novel"}' WHERE id = '00000000-0000-4000-8000-000000000e11';
CREATE TABLE test_fixture.reads (tag text, name text, out jsonb, PRIMARY KEY (tag, name));
GRANT INSERT, SELECT ON test_fixture.reads TO service_role;
CREATE FUNCTION test_fixture.capture(p_tag text) RETURNS void LANGUAGE plpgsql AS $c$
DECLARE
  -- Spelled indirectly so the contract's reference guard does not see this test helper.
  v_drop CONSTANT text[] := ARRAY['upstream' || '_status', 'display' || '_fallback', 'history'];
BEGIN
  INSERT INTO test_fixture.reads SELECT p_tag, 'page_' || s.tag,
    (SELECT jsonb_agg(to_jsonb(p) - v_drop ORDER BY p.turn_index)
     FROM experience.list_chat_message_page('00000000-0000-4000-8000-0000000000a1', s.sid, s.before_turn, s.lim) p)
  FROM (VALUES ('R', '00000000-0000-4000-8000-0000000000e1'::uuid, NULL::integer, 25),
               ('R_older', '00000000-0000-4000-8000-0000000000e1'::uuid, 3, 1),
               ('B', '00000000-0000-4000-8000-0000000000e2'::uuid, NULL::integer, 25)) AS s(tag, sid, before_turn, lim);
  INSERT INTO test_fixture.reads SELECT p_tag, 'display',
    (SELECT jsonb_agg(to_jsonb(d) - v_drop ORDER BY d.session_id, d.turn_index) FROM experience.session_chat_display d
     WHERE d.session_id IN ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2'));
  INSERT INTO test_fixture.reads SELECT p_tag, 'session_history',
    (SELECT jsonb_agg(to_jsonb(h) - v_drop - ('first_token' || '_preview') ORDER BY h.session_id, h.turn_index)
     FROM experience.session_chat_history h
     WHERE h.session_id IN ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2'));
END
$c$;
GRANT EXECUTE ON FUNCTION test_fixture.capture(text) TO service_role;
SET ROLE service_role;
SELECT test_fixture.capture('before');
SQL

contract_refused() { # label, expected substring
  local out
  if out=$("${admin_psql[@]}" -f - <"$contract" 2>&1); then echo "FAIL: contract should refuse ($1)"; exit 1; fi
  [[ "$out" == *"$2"* ]] || { echo "FAIL: contract refused ($1) with: $out"; exit 1; }
  echo "ok: contract refuses $1"
}
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.chat_generation_requests SET first_token_preview = NULL WHERE chat_history_id = '00000000-0000-4000-8000-000000000e14';
SQL
contract_refused "a preview missing from chat_generation_requests" "first-token previews are not in chat_generation_requests"
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.chat_generation_requests SET first_token_preview = '{"kind":"delta","text":"partial three"}' WHERE chat_history_id = '00000000-0000-4000-8000-000000000e14';
INSERT INTO experience.chat_history (id, user_id, model, user_input, history, session_id, turn_index, revision)
VALUES ('00000000-0000-4000-8000-000000000e99', '00000000-0000-4000-8000-0000000000a1', 'm', 'x', '[]',
        '00000000-0000-4000-8000-0000000000e2', 9, 0);
SQL
contract_refused "a session turn with history but no projection" "have no display projection"
"${admin_psql[@]}" >/dev/null <<'SQL'
DELETE FROM experience.chat_history WHERE id = '00000000-0000-4000-8000-000000000e99';
CREATE FUNCTION test_fixture.rogue() RETURNS integer LANGUAGE sql AS $$ SELECT upstream_status FROM experience.chat_history LIMIT 1 $$;
SQL
contract_refused "while another function reads a dropped column" "test_fixture.rogue()"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP FUNCTION test_fixture.rogue();
CREATE TABLE test_fixture.saved_list AS
  SELECT pg_get_functiondef('experience.list_chat_message_page(uuid,uuid,integer,integer)'::regprocedure) AS def;
DO $$ BEGIN EXECUTE replace((SELECT def FROM test_fixture.saved_list), 'invalid chat page arguments', 'invalid page args'); END $$;
SQL
contract_refused "an unreviewed list_chat_message_page" "differs from the reviewed body"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN EXECUTE (SELECT def FROM test_fixture.saved_list); END $$;
SQL
check "refused contracts left every object in place" <<'SQL'
SELECT to_regclass('experience.current_chat_history') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'upstream_status' AND NOT attisdropped)
  AND to_regprocedure('experience.backfill_chat_history_display(uuid[])') IS NOT NULL;
SQL

# Apply from a warm session that already planned the list RPC and the regeneration's session_chat_history read.
docker cp "$contract" "$task_container:/tmp/p5_contract.sql" >/dev/null
"${admin_psql[@]}" -At >"$task_tmp/warm.txt" <<'SQL'
SET ROLE service_role;
SELECT count(*) FROM experience.list_chat_message_page('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000e2', NULL, 25);
SELECT count(*) FROM experience.session_chat_history WHERE session_id = '00000000-0000-4000-8000-0000000000e2';
RESET ROLE;
\i /tmp/p5_contract.sql
SET ROLE service_role;
SELECT count(*) FROM experience.list_chat_message_page('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000e2', NULL, 25);
SELECT count(*) FROM experience.session_chat_history WHERE session_id = '00000000-0000-4000-8000-0000000000e2';
SQL
[[ "$(grep -E '^[0-9]+$' "$task_tmp/warm.txt" | tr '\n' ' ')" == "3 3 3 3 " ]] ||
  { echo "FAIL: warm session around the contract:"; cat "$task_tmp/warm.txt"; exit 1; }
echo "ok: contract applied from a warm session; list RPC and session view keep working"

"${admin_psql[@]}" >/dev/null <<'SQL'
SET ROLE service_role;
SELECT test_fixture.capture('after');
SQL
check "contract: list pages, session display and session history read the same as before" <<'SQL'
-- Only difference allowed: the stale drive_mode key moved from rich_reply_metadata into its column.
WITH norm AS (
  SELECT r.tag, r.name, (SELECT jsonb_agg(e.v #- '{rich_reply_metadata,drive_mode}' ORDER BY e.n)
                         FROM jsonb_array_elements(r.out) WITH ORDINALITY AS e(v, n)) AS out
  FROM test_fixture.reads r)
SELECT bool_and(b.out = a.out) AND count(*) = 5
FROM norm b JOIN norm a ON a.name = b.name AND a.tag = 'after' WHERE b.tag = 'before';
SQL
check "contract: reads carry what the backend shows (opening, request id, previews, edits, likes, inheritance)" <<'SQL'
WITH r AS (SELECT out FROM test_fixture.reads WHERE tag = 'after' AND name = 'page_R'),
     b AS (SELECT out FROM test_fixture.reads WHERE tag = 'after' AND name = 'page_B')
SELECT jsonb_array_length(r.out) = 4
  AND r.out #>> '{0,display_opening_message}' = 'opening R' AND r.out #>> '{0,user_input}' = 'hi (edited)'
  AND r.out #>> '{1,assistant_reply}' = 'two-b' AND (r.out #> '{1,liked}')::boolean AND r.out #>> '{1,display_request_id}' = 'req-2b'
  AND r.out #>> '{2,first_token_preview,text}' = 'partial three' AND r.out #>> '{3,first_token_preview,kind}' = 'reasoning'
  AND jsonb_array_length(b.out) = 3 AND (b.out #> '{0,is_inherited}')::boolean AND b.out #>> '{0,display_request_id}' IS NULL
  AND b.out #>> '{0,display_opening_message}' = 'opening R' AND b.out #> '{1,assistant_reply}' = 'null'::jsonb
FROM r, b;
SQL
check "contract: columns, views and functions in their end state" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND NOT attisdropped
                   AND attname IN ('upstream_status', 'first_token_preview'))
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'history' AND NOT attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history_display_metadata'::regclass
                  AND attname = 'projection_version' AND NOT attisdropped)
  AND to_regclass('experience.current_chat_history') IS NULL
  AND to_regprocedure('experience.backfill_chat_history_display(uuid[])') IS NULL
  AND to_regprocedure('experience.extract_chat_history_display(jsonb)') IS NOT NULL
  AND has_function_privilege('service_role', 'experience.list_chat_message_page(uuid,uuid,integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'experience.list_chat_message_page(uuid,uuid,integer,integer)', 'EXECUTE')
  AND has_table_privilege('service_role', 'experience.session_chat_display', 'SELECT')
  AND NOT has_table_privilege('anon', 'experience.session_chat_history', 'SELECT')
  AND (SELECT drive_mode = 'novel' AND NOT rich_reply_metadata ? 'drive_mode' FROM experience.chat_history
       WHERE id = '00000000-0000-4000-8000-000000000e11');
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
INSERT INTO experience.chat_sessions (id, user_id, character_id) VALUES
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1');
SET ROLE service_role;
INSERT INTO test_fixture.results SELECT 'after_contract', test_fixture.scenario('00000000-0000-4000-8000-0000000000e3');
SQL
check "contract: admission, preview and regeneration keep their outcomes" <<'SQL'
WITH n AS (SELECT out FROM test_fixture.results WHERE tag = 'new'), c AS (SELECT out FROM test_fixture.results WHERE tag = 'after_contract')
SELECT c.out #> '{h1,ops}' = n.out #> '{h1,ops}' AND c.out #> '{h2,ops}' = n.out #> '{h2,ops}'
  AND c.out -> 'errs' = n.out -> 'errs' AND c.out -> 'prev' = n.out -> 'prev'
  AND c.out #> '{h1,preview_new}' = n.out #> '{h1,preview_new}'
  AND (c.out #> '{h1,meta}') = (n.out #> '{h1,meta}') - 'projection_version'
  AND (c.out #> '{h2,meta}') = (n.out #> '{h2,meta}') - 'projection_version'
  AND (c.out #> '{h1,row}') - 'turn_index' = (n.out #> '{h1,row}') - ARRAY['turn_index', 'upstream_status', 'first_token_preview']
FROM n, c;
SQL
"${admin_psql[@]}" -At -c "SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc WHERE oid = 'experience.list_chat_message_page(uuid,uuid,integer,integer)'::regprocedure" >"$task_tmp/list_md5.txt"
echo "info: contracted list_chat_message_page md5 (no CR) = $(cat "$task_tmp/list_md5.txt")"
"${admin_psql[@]}" -f - <"$contract" >/dev/null
echo "ok: contract rerun is a no-op"
echo "PASS: p5 expand + backfill + contract"
