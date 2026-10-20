-- Local-only post-migration scenarios. Run after text_postprocess_t2.run().
DO $scenario$
DECLARE
  v_session constant uuid := '00000000-0000-4000-8000-0000000002d1';
  v_user constant uuid := '00000000-0000-4000-8000-0000000002d2';
  v_started jsonb;
  v_turn integer;
BEGIN
  INSERT INTO experience.chat_sessions (id, user_id) VALUES (v_session, v_user);
  FOR v_turn IN 1..3 LOOP
    v_started := experience.start_chat_history_turn_with_current_postprocess(v_session, 'turn ' || v_turn, 'model', 120, 75, 50);
    IF v_started ->> 'choice_rules_mode' <> 'full' OR v_started ->> 'status_rules_mode' <> 'full' OR v_started ->> 'memory_rules_mode' <> 'full' THEN
      RAISE EXCEPTION 'dynamic rich reply scenario: turn % was not full', v_turn;
    END IF;
    UPDATE experience.chat_history SET status = 'success', rich_reply_metadata = '{"rich_reply_mode":"full","rich_reply_result":"exact","rich_reply_issues":[]}'::jsonb
    WHERE id = (v_started ->> 'history_id')::uuid;
  END LOOP;
  v_started := experience.start_chat_history_turn_with_current_postprocess(v_session, 'turn 4', 'model', 120, 75, 50);
  IF v_started ->> 'choice_rules_mode' <> 'concise' THEN RAISE EXCEPTION 'dynamic rich reply scenario: exact predecessor was not concise'; END IF;
  UPDATE experience.chat_history SET status = 'success', rich_reply_metadata = '{"rich_reply_mode":"concise","rich_reply_result":"recovered","rich_reply_issues":["MISSING_MEMORY_CLOSE_AT_EOF"]}'::jsonb
  WHERE id = (v_started ->> 'history_id')::uuid;
  v_started := experience.start_chat_history_turn_with_current_postprocess(v_session, 'turn 5', 'model', 120, 75, 50);
  IF v_started ->> 'choice_rules_mode' <> 'full' THEN RAISE EXCEPTION 'dynamic rich reply scenario: recovered predecessor was not full'; END IF;
  UPDATE experience.chat_history SET status = 'success' WHERE id = (v_started ->> 'history_id')::uuid;
  v_started := experience.start_chat_history_regeneration_with_current_postprocess(v_session, 5, 'model', 120, 75, 50);
  IF v_started ->> 'choice_rules_mode' <> 'full' THEN RAISE EXCEPTION 'dynamic rich reply scenario: unknown replaced revision was not full'; END IF;
END
$scenario$;
