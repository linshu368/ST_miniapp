-- 20261014_rich_reply_dynamic_mode.sql
-- domain: experience (immutable per-revision rich reply diagnostic)
--
-- The backend is the only writer of this bounded result snapshot after a
-- successful reply. It is deliberately separate from prompt/history and LLM
-- billing metadata. Missing data is a safe signal: the next turn uses full.

BEGIN;

ALTER TABLE experience.chat_history
  ADD COLUMN IF NOT EXISTS rich_reply_metadata jsonb;

ALTER TABLE experience.chat_history
  DROP CONSTRAINT IF EXISTS chat_history_rich_reply_metadata_check;
ALTER TABLE experience.chat_history
  ADD CONSTRAINT chat_history_rich_reply_metadata_check
  CHECK (
    rich_reply_metadata IS NULL OR (
      pg_catalog.jsonb_typeof(rich_reply_metadata) = 'object'
      AND rich_reply_metadata ?& ARRAY['rich_reply_mode', 'rich_reply_result', 'rich_reply_issues']
      AND rich_reply_metadata ->> 'rich_reply_mode' IN ('full', 'concise')
      AND rich_reply_metadata ->> 'rich_reply_result' IN ('exact', 'recovered', 'failed')
      AND pg_catalog.jsonb_typeof(rich_reply_metadata -> 'rich_reply_issues') = 'array'
      AND pg_catalog.jsonb_array_length(rich_reply_metadata -> 'rich_reply_issues') <= 8
    )
  ) NOT VALID;
ALTER TABLE experience.chat_history
  VALIDATE CONSTRAINT chat_history_rich_reply_metadata_check;

COMMENT ON COLUMN experience.chat_history.rich_reply_metadata IS
  '本 revision 的最小富文本协议诊断；仅成功终态由 Backend 写入。缺失代表未知，下一逻辑轮保守使用 full。';

-- Preserve every existing explicit view column and append only this snapshot.
DO $view$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(pg_catalog.quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_cols
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'experience.current_chat_history'::regclass
    AND attnum > 0 AND NOT attisdropped AND attname <> 'rich_reply_metadata';
  IF v_cols IS NULL THEN RAISE EXCEPTION 'current_chat_history has no columns'; END IF;
  EXECUTE format(
    'CREATE OR REPLACE VIEW experience.current_chat_history WITH (security_invoker = true) AS
     SELECT DISTINCT ON (session_id, turn_index) %s, rich_reply_metadata
     FROM experience.chat_history
     WHERE session_id IS NOT NULL AND turn_index IS NOT NULL AND revision IS NOT NULL
     ORDER BY session_id, turn_index, revision DESC', v_cols
  );
END
$view$;
REVOKE ALL ON experience.current_chat_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.current_chat_history TO service_role, postgres;

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  p_session_id uuid, p_user_content text, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_version integer; v_user_id uuid; v_started jsonb; v_history_id uuid; v_turn_index integer;
  v_settings record; v_previous_exact boolean := false; v_mode text;
BEGIN
  SELECT runtime.version INTO v_version
  FROM app_core.runtime_config AS runtime JOIN app_core.text_postprocess_versions AS snapshot ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config' AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1 AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';
  IF NOT FOUND THEN RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001'; END IF;
  SELECT user_id INTO v_user_id FROM experience.chat_sessions WHERE id = p_session_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO app_core.miniapp_user_settings (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
  v_started := experience.start_chat_history_turn_with_postprocess(p_session_id, p_user_content, p_model, v_version, p_stale_after_seconds, p_max_context_turns, p_retain_context_turns);
  v_history_id := (v_started ->> 'history_id')::uuid; v_turn_index := (v_started ->> 'turn_index')::integer;
  IF v_history_id IS NULL OR v_turn_index IS NULL OR v_turn_index < 1 THEN RAISE EXCEPTION 'started history row is missing a valid identity' USING ERRCODE = '55000'; END IF;
  SELECT pref_show_options, pref_show_status, pref_show_memory INTO v_settings FROM app_core.miniapp_user_settings WHERE user_id = v_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002'; END IF;
  IF v_turn_index > 3 THEN
    SELECT COALESCE(history.rich_reply_metadata ->> 'rich_reply_result' = 'exact', false) INTO v_previous_exact
    FROM experience.chat_history AS history
    WHERE history.session_id = p_session_id AND history.turn_index = v_turn_index - 1
    ORDER BY history.revision DESC LIMIT 1;
  END IF;
  v_mode := CASE WHEN v_turn_index <= 3 OR NOT v_previous_exact THEN 'full' ELSE 'concise' END;
  PERFORM experience.instruction_slot_mode_bind_enter();
  UPDATE experience.chat_history SET
    choice_rules_mode = CASE WHEN v_settings.pref_show_options THEN v_mode ELSE 'off' END,
    status_rules_mode = CASE WHEN v_settings.pref_show_status THEN v_mode ELSE 'off' END,
    memory_rules_mode = CASE WHEN v_settings.pref_show_memory THEN v_mode ELSE 'off' END
  WHERE id = v_history_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000'; END IF;
  RETURN v_started || (SELECT pg_catalog.jsonb_build_object('choice_rules_mode', choice_rules_mode, 'status_rules_mode', status_rules_mode, 'memory_rules_mode', memory_rules_mode) FROM experience.chat_history WHERE id = v_history_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  p_session_id uuid, p_turn_index integer, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_version integer; v_user_id uuid; v_started jsonb; v_history_id uuid; v_turn_index integer; v_revision integer;
  v_settings record; v_previous_exact boolean := false; v_mode text;
BEGIN
  SELECT runtime.version INTO v_version
  FROM app_core.runtime_config AS runtime JOIN app_core.text_postprocess_versions AS snapshot ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config' AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1 AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';
  IF NOT FOUND THEN RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001'; END IF;
  SELECT user_id INTO v_user_id FROM experience.chat_sessions WHERE id = p_session_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO app_core.miniapp_user_settings (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
  v_started := experience.start_chat_history_regeneration_with_postprocess(p_session_id, p_turn_index, p_model, v_version, p_stale_after_seconds, p_max_context_turns, p_retain_context_turns);
  v_history_id := (v_started ->> 'history_id')::uuid; v_turn_index := (v_started ->> 'turn_index')::integer; v_revision := (v_started ->> 'revision')::integer;
  IF v_history_id IS NULL OR v_turn_index IS NULL OR v_revision IS NULL THEN RAISE EXCEPTION 'started history row is missing a valid identity' USING ERRCODE = '55000'; END IF;
  SELECT pref_show_options, pref_show_status, pref_show_memory INTO v_settings FROM app_core.miniapp_user_settings WHERE user_id = v_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002'; END IF;
  IF v_turn_index > 3 THEN
    SELECT COALESCE(history.rich_reply_metadata ->> 'rich_reply_result' = 'exact', false) INTO v_previous_exact
    FROM experience.chat_history AS history
    WHERE history.session_id = p_session_id AND history.turn_index = v_turn_index AND history.revision < v_revision
    ORDER BY history.revision DESC LIMIT 1;
  END IF;
  v_mode := CASE WHEN v_turn_index <= 3 OR NOT v_previous_exact THEN 'full' ELSE 'concise' END;
  PERFORM experience.instruction_slot_mode_bind_enter();
  UPDATE experience.chat_history SET
    choice_rules_mode = CASE WHEN v_settings.pref_show_options THEN v_mode ELSE 'off' END,
    status_rules_mode = CASE WHEN v_settings.pref_show_status THEN v_mode ELSE 'off' END,
    memory_rules_mode = CASE WHEN v_settings.pref_show_memory THEN v_mode ELSE 'off' END
  WHERE id = v_history_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000'; END IF;
  RETURN v_started || (SELECT pg_catalog.jsonb_build_object('choice_rules_mode', choice_rules_mode, 'status_rules_mode', status_rules_mode, 'memory_rules_mode', memory_rules_mode) FROM experience.chat_history WHERE id = v_history_id);
END;
$fn$;

ALTER FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) TO service_role, postgres;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- TEST postflight: turns 1-3 are full; an exact turn 3 makes turn 4 concise;
-- recovered/failed/NULL makes the next logical turn full; regenerating a
-- non-exact revision is full; disabled slots remain off. Verify function owner,
-- SECURITY DEFINER/search_path and ACL after applying one migration.
