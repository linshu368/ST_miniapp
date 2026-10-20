-- Minimal local-only precondition for 20261013_platform_instruction_slot_windows.sql.
-- It models the 20260930 current-postprocess wrappers and their dependencies;
-- it is not an application migration and must never be run against TEST/Production.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA app_core;
CREATE SCHEMA experience;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_core.miniapp_user_settings (
  user_id uuid PRIMARY KEY,
  pref_show_options boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_core.runtime_config (
  key text PRIMARY KEY,
  version integer NOT NULL,
  value jsonb NOT NULL
);
CREATE TABLE app_core.text_postprocess_versions (
  version integer PRIMARY KEY,
  schema_version integer NOT NULL,
  policy_version integer NOT NULL,
  artifact jsonb NOT NULL
);
CREATE TABLE experience.chat_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  turn_index integer NOT NULL,
  revision integer NOT NULL,
  user_content text,
  model text,
  postprocess_version integer,
  UNIQUE (session_id, turn_index, revision)
);
CREATE VIEW experience.current_chat_history WITH (security_invoker = true) AS
  SELECT DISTINCT ON (session_id, turn_index) *
  FROM experience.chat_history
  ORDER BY session_id, turn_index, revision DESC;

ALTER TABLE app_core.miniapp_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.chat_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA app_core, experience FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app_core, experience TO service_role, postgres;

INSERT INTO app_core.text_postprocess_versions (version, schema_version, policy_version, artifact)
VALUES (1, 1, 1, '{"schema_version": 1, "policy_version": 1, "rules": []}');
INSERT INTO app_core.runtime_config (key, version, value)
VALUES ('miniapp_text_postprocess_config', 1, '{"version": 1, "schema_version": 1, "policy_version": 1}');

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_postprocess(
  p_session_id uuid, p_user_content text, p_model text, p_postprocess_version integer,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_history_id uuid; v_turn_index integer;
BEGIN
  PERFORM 1 FROM experience.chat_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE = 'P0002'; END IF;
  SELECT COALESCE(max(turn_index), 0) + 1 INTO v_turn_index
  FROM experience.chat_history WHERE session_id = p_session_id;
  INSERT INTO experience.chat_history (session_id, turn_index, revision, user_content, model, postprocess_version)
  VALUES (p_session_id, v_turn_index, 1, p_user_content, p_model, p_postprocess_version)
  RETURNING id INTO v_history_id;
  IF p_user_content = '__fail_after_claim__' THEN
    RAISE EXCEPTION 'local injected turn-start failure' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_content = '__concurrent__' THEN PERFORM pg_catalog.pg_sleep(0.20); END IF;
  RETURN jsonb_build_object('history_id', v_history_id, 'turn_index', v_turn_index);
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration_with_postprocess(
  p_session_id uuid, p_turn_index integer, p_model text, p_postprocess_version integer,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_history_id uuid; v_revision integer;
BEGIN
  PERFORM 1 FROM experience.chat_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM experience.chat_history WHERE session_id = p_session_id AND turn_index = p_turn_index) THEN
    RAISE EXCEPTION 'turn not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT max(revision) + 1 INTO v_revision FROM experience.chat_history WHERE session_id = p_session_id AND turn_index = p_turn_index;
  INSERT INTO experience.chat_history (session_id, turn_index, revision, model, postprocess_version)
  VALUES (p_session_id, p_turn_index, v_revision, p_model, p_postprocess_version) RETURNING id INTO v_history_id;
  RETURN jsonb_build_object('history_id', v_history_id, 'turn_index', p_turn_index);
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  p_session_id uuid, p_user_content text, p_model text, p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75, p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_version integer;
BEGIN
  SELECT runtime.version INTO v_version FROM app_core.runtime_config runtime
  JOIN app_core.text_postprocess_versions snapshot ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config';
  IF NOT FOUND THEN RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001'; END IF;
  RETURN experience.start_chat_history_turn_with_postprocess(p_session_id, p_user_content, p_model, v_version, p_stale_after_seconds, p_max_context_turns, p_retain_context_turns);
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  p_session_id uuid, p_turn_index integer, p_model text, p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75, p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_version integer;
BEGIN
  SELECT runtime.version INTO v_version FROM app_core.runtime_config runtime
  JOIN app_core.text_postprocess_versions snapshot ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config';
  IF NOT FOUND THEN RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001'; END IF;
  RETURN experience.start_chat_history_regeneration_with_postprocess(p_session_id, p_turn_index, p_model, v_version, p_stale_after_seconds, p_max_context_turns, p_retain_context_turns);
END;
$fn$;

ALTER FUNCTION experience.start_chat_history_turn_with_postprocess(uuid, text, text, integer, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_regeneration_with_postprocess(uuid, integer, text, integer, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) TO service_role, postgres;

-- A historic settings row proves that pref_show_options is preserved by T2.
INSERT INTO app_core.miniapp_user_settings (user_id, pref_show_options)
VALUES ('00000000-0000-0000-0000-000000000001', false);
