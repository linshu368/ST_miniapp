-- 20261013_session_scoped_instruction_slot_modes.sql
-- domain: experience (conversation turn state)
-- forward-fix for 20261013_platform_instruction_slot_windows.sql
--
-- The full/concise window is a property of each chat session, not a user-wide
-- allowance. chat_history.turn_index is already allocated atomically by the
-- underlying start-turn RPC, so it remains the only counter/state source.
-- Legacy app_core.*_full_rules_remaining columns and claim helpers are retained
-- temporarily for rollback compatibility but are no longer consumed here.

BEGIN;

COMMENT ON COLUMN app_core.miniapp_user_settings.choice_full_rules_remaining IS
  'Legacy rollback-only counter. Runtime full/concise mode is session-scoped by chat_history.turn_index.';
COMMENT ON COLUMN app_core.miniapp_user_settings.status_full_rules_remaining IS
  'Legacy rollback-only counter. Runtime full/concise mode is session-scoped by chat_history.turn_index.';
COMMENT ON COLUMN app_core.miniapp_user_settings.memory_full_rules_remaining IS
  'Legacy rollback-only counter. Runtime full/concise mode is session-scoped by chat_history.turn_index.';

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  p_session_id uuid, p_user_content text, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_version integer;
  v_user_id uuid;
  v_started jsonb;
  v_history_id uuid;
  v_turn_index integer;
  v_settings record;
  v_choice_mode text;
  v_status_mode text;
  v_memory_mode text;
BEGIN
  SELECT runtime.version INTO v_version
  FROM app_core.runtime_config AS runtime
  JOIN app_core.text_postprocess_versions AS snapshot ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config'
    AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb
    AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1
    AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb
    AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT user_id INTO v_user_id
  FROM experience.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app_core.miniapp_user_settings (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  v_started := experience.start_chat_history_turn_with_postprocess(
    p_session_id,
    p_user_content,
    p_model,
    v_version,
    p_stale_after_seconds,
    p_max_context_turns,
    p_retain_context_turns
  );
  v_history_id := (v_started ->> 'history_id')::uuid;
  v_turn_index := (v_started ->> 'turn_index')::integer;
  IF v_history_id IS NULL OR v_turn_index IS NULL OR v_turn_index < 1 THEN
    RAISE EXCEPTION 'started history row is missing a valid identity' USING ERRCODE = '55000';
  END IF;

  -- Keep preference and mode binding in the same transaction. Concurrent
  -- preference updates serialize on this row; concurrent sessions do not share
  -- any decrementing counter and therefore cannot consume one another's window.
  SELECT pref_show_options, pref_show_status, pref_show_memory INTO v_settings
  FROM app_core.miniapp_user_settings
  WHERE user_id = v_user_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002';
  END IF;

  v_choice_mode := CASE
    WHEN NOT v_settings.pref_show_options THEN 'off'
    WHEN v_turn_index <= 2 THEN 'full'
    ELSE 'concise'
  END;
  v_status_mode := CASE
    WHEN NOT v_settings.pref_show_status THEN 'off'
    WHEN v_turn_index <= 2 THEN 'full'
    ELSE 'concise'
  END;
  v_memory_mode := CASE
    WHEN NOT v_settings.pref_show_memory THEN 'off'
    WHEN v_turn_index <= 2 THEN 'full'
    ELSE 'concise'
  END;

  PERFORM experience.instruction_slot_mode_bind_enter();
  UPDATE experience.chat_history
  SET choice_rules_mode = v_choice_mode,
      status_rules_mode = v_status_mode,
      memory_rules_mode = v_memory_mode
  WHERE id = v_history_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000';
  END IF;

  RETURN v_started || pg_catalog.jsonb_build_object(
    'choice_rules_mode', v_choice_mode,
    'status_rules_mode', v_status_mode,
    'memory_rules_mode', v_memory_mode
  );
END;
$fn$;

ALTER FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) TO service_role, postgres;

DO $selfcheck$
DECLARE
  v_definition text;
  v_owner name;
  v_definer boolean;
  v_config text[];
BEGIN
  SELECT pg_catalog.pg_get_functiondef(proc.oid),
         pg_catalog.pg_get_userbyid(proc.proowner),
         proc.prosecdef,
         proc.proconfig
  INTO v_definition, v_owner, v_definer, v_config
  FROM pg_catalog.pg_proc AS proc
  WHERE proc.oid = 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)'::regprocedure;

  IF v_definition IS NULL
     OR v_definition LIKE '%claim_instruction_slot_modes%'
     OR v_definition NOT LIKE '%v_turn_index <= 2%'
     OR v_owner IS DISTINCT FROM 'postgres'
     OR v_definer IS DISTINCT FROM true
     OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION '20261013 session-scoped instruction modes self-check failed';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '20261013 session-scoped instruction modes unsafe ACL';
  END IF;
END
$selfcheck$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- TEST postflight (manual, isolated fixtures):
-- 1. For session A and B of the same user, start turns 1/2/3 and verify each is
--    full/full/concise independently; verify a disabled slot is always off.
-- 2. Regenerate turn 1 and turn 3 and verify the prior mode snapshot is copied.
-- 3. Start turns concurrently in different sessions and verify neither consumes
--    or changes the other's modes. Re-check owner/search_path/ACL after apply.
-- Production remains a separate authorization gate. Application rollback keeps
-- all retained columns/functions; database defects use a reviewed forward-fix.
