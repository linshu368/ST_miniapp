\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', p_message; END IF;
END;
$$;

-- Historical preference is preserved; the two new defaults and counts are initialized correctly.
SELECT pg_temp.assert_true(
  (SELECT NOT pref_show_options AND pref_show_status AND pref_show_memory
    AND choice_full_rules_remaining = 0 AND status_full_rules_remaining = 2 AND memory_full_rules_remaining = 2
   FROM app_core.miniapp_user_settings WHERE user_id = '00000000-0000-0000-0000-000000000001'),
  'historic pref_show_options and default slot state');

INSERT INTO experience.chat_sessions (id, user_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004');

-- Three logical turns consume full/full/concise independently for every slot.
SELECT experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000001', 'one', 'local');
SELECT experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000001', 'two', 'local');
SELECT experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000001', 'three', 'local');
SELECT pg_temp.assert_true(
  (SELECT array_agg(choice_rules_mode ORDER BY turn_index) = ARRAY['full','full','concise']
       AND array_agg(status_rules_mode ORDER BY turn_index) = ARRAY['full','full','concise']
       AND array_agg(memory_rules_mode ORDER BY turn_index) = ARRAY['full','full','concise']
   FROM experience.current_chat_history WHERE session_id = '10000000-0000-0000-0000-000000000001'),
  'full/full/concise snapshots');

-- Regeneration uses the original snapshot and does not consume another count.
SELECT experience.start_chat_history_regeneration_with_current_postprocess('10000000-0000-0000-0000-000000000001', 1, 'local');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 AND count(DISTINCT choice_rules_mode) = 1 AND count(DISTINCT status_rules_mode) = 1 AND count(DISTINCT memory_rules_mode) = 1
   FROM experience.chat_history WHERE session_id = '10000000-0000-0000-0000-000000000001' AND turn_index = 1),
  'regeneration reuses a stable snapshot');
SELECT pg_temp.assert_true(
  (SELECT choice_full_rules_remaining = 0 AND status_full_rules_remaining = 0 AND memory_full_rules_remaining = 0
   FROM app_core.miniapp_user_settings WHERE user_id = '10000000-0000-0000-0000-000000000001'),
  'regeneration does not consume counts');

-- Only the slot actually toggled false -> true is reset; off never consumes and reopen gets full again.
SELECT * FROM app_core.update_instruction_slot_preferences('10000000-0000-0000-0000-000000000001', false, NULL, NULL);
SELECT pg_temp.assert_true((SELECT choice_full_rules_remaining = 0 AND status_full_rules_remaining = 0 AND memory_full_rules_remaining = 0
  FROM app_core.miniapp_user_settings WHERE user_id = '10000000-0000-0000-0000-000000000001'), 'turning choice off leaves other counts unchanged');
SELECT experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000001', 'off', 'local');
SELECT pg_temp.assert_true((SELECT choice_rules_mode = 'off' FROM experience.current_chat_history WHERE session_id = '10000000-0000-0000-0000-000000000001' AND turn_index = 4), 'off mode');
SELECT * FROM app_core.update_instruction_slot_preferences('10000000-0000-0000-0000-000000000001', true, NULL, NULL);
SELECT pg_temp.assert_true((SELECT choice_full_rules_remaining = 2 AND status_full_rules_remaining = 0 AND memory_full_rules_remaining = 0
  FROM app_core.miniapp_user_settings WHERE user_id = '10000000-0000-0000-0000-000000000001'), 'only reopened choice resets');
SELECT experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000001', 'reopen', 'local');
SELECT pg_temp.assert_true((SELECT choice_rules_mode = 'full' AND status_rules_mode = 'concise' AND memory_rules_mode = 'concise'
  FROM experience.current_chat_history WHERE session_id = '10000000-0000-0000-0000-000000000001' AND turn_index = 5), 'reopen starts full while untouched slots stay concise');

-- A failed turn occurs after claim but its statement transaction must restore both count and history.
INSERT INTO app_core.miniapp_user_settings (user_id) VALUES ('10000000-0000-0000-0000-000000000002');
DO $$ BEGIN
  PERFORM experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000002', '__fail_after_claim__', 'local');
  RAISE EXCEPTION 'expected injected failure';
EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END $$;
SELECT pg_temp.assert_true((SELECT choice_full_rules_remaining = 2 AND status_full_rules_remaining = 2 AND memory_full_rules_remaining = 2
  FROM app_core.miniapp_user_settings WHERE user_id = '10000000-0000-0000-0000-000000000002'), 'failed turn rolls back counts');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM experience.chat_history WHERE session_id = '10000000-0000-0000-0000-000000000002'), 'failed turn leaves no history');

-- Snapshot guard and claim guard reject direct writes.
DO $$ BEGIN
  UPDATE experience.chat_history SET choice_rules_mode = 'off' WHERE session_id = '10000000-0000-0000-0000-000000000001' AND turn_index = 1;
  RAISE EXCEPTION 'expected mode guard failure';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE app_core.miniapp_user_settings SET choice_full_rules_remaining = 2 WHERE user_id = '10000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'expected claim guard failure';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- Catalog/RLS/ACL checks required for the migration's security boundary.
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid IN (
    'app_core.update_instruction_slot_preferences(uuid,boolean,boolean,boolean)'::regprocedure,
    'app_core.claim_instruction_slot_modes(uuid)'::regprocedure,
    'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)'::regprocedure,
    'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'::regprocedure)
  AND (pg_get_userbyid(p.proowner) <> 'postgres' OR NOT p.prosecdef OR NOT COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'])
), 'postgres SECURITY DEFINER search_path');
SELECT pg_temp.assert_true(
  has_function_privilege('service_role', 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)', 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc AS proc
    CROSS JOIN LATERAL aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS acl
    WHERE proc.oid = 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'turn RPC execute ACL');
SELECT pg_temp.assert_true(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'app_core.miniapp_user_settings'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'experience.chat_history'::regclass)
  AND NOT has_table_privilege('anon', 'experience.current_chat_history', 'SELECT')
  AND has_table_privilege('service_role', 'experience.current_chat_history', 'SELECT'),
  'RLS and view grants');
SELECT pg_temp.assert_true((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'experience.current_chat_history'::regclass), 'current view security invoker');

\echo assertions-before-concurrency-passed
