-- Synthetic PG17 regression. No provider calls, real identities or remote data.
BEGIN;
SET LOCAL statement_timeout='30s';
DO $test$
DECLARE s record; actual jsonb; expected jsonb; boundary integer; ids uuid[]; seen uuid[];
  page_ids uuid[]; n integer; original jsonb; hid uuid; input jsonb; frozen jsonb;
BEGIN
  -- Compare every visible field against the original branch/revision/override view.
  -- Run once with missing projections and again with fully backfilled projections.
  FOR n IN 0..1 LOOP
    IF n=1 THEN
      FOR ids IN SELECT array_agg(id) FROM (
        SELECT id,(row_number() OVER(ORDER BY id)-1)/100 AS batch FROM experience.chat_history
      ) grouped GROUP BY batch LOOP
        PERFORM experience.backfill_chat_history_display(ids);
      END LOOP;
    END IF;
    FOR s IN SELECT * FROM experience.chat_sessions WHERE deleted_at IS NULL LOOP
      boundary:=NULL; seen:='{}';
      LOOP
        SELECT jsonb_agg(to_jsonb(p)-'display_request_id'-'display_opening_message'-'display_fallback' ORDER BY turn_index DESC),
          array_agg(id ORDER BY turn_index DESC)
        INTO actual,page_ids FROM experience.list_chat_message_page(s.user_id,s.id,boundary,7) p;
        SELECT jsonb_agg(to_jsonb(p)-'history' ORDER BY turn_index DESC) INTO expected FROM (
          SELECT * FROM experience.session_chat_history WHERE session_id=s.id
            AND (boundary IS NULL OR turn_index<boundary) ORDER BY turn_index DESC LIMIT 8
        ) p;
        IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'display fields differ (projection round %, session %)',n,s.id; END IF;
        IF page_ids IS NULL THEN EXIT; END IF;
        seen:=seen||page_ids[1:7];
        IF cardinality(page_ids)<=7 THEN EXIT; END IF;
        SELECT turn_index INTO boundary FROM experience.list_chat_message_page(s.user_id,s.id,boundary,7) OFFSET 6 LIMIT 1;
      END LOOP;
      IF cardinality(seen)<>(SELECT count(*) FROM experience.session_chat_history WHERE session_id=s.id)
        OR cardinality(seen)<>(SELECT count(DISTINCT x) FROM unnest(seen) x) THEN
        RAISE EXCEPTION 'cursor lost or duplicated history';
      END IF;
    END LOOP;
  END LOOP;
  -- Exact strings, null-vs-missing and JavaScript trim semantics, without UUID normalization.
  SELECT to_jsonb(d) INTO actual FROM experience.extract_chat_history_display(
    '[null,{"request_id":"  RAW-Request  ","role":"assistant","content":"  opening  "}]') d;
  IF actual<>'{"request_id":"  RAW-Request  ","opening_message":"opening"}'::jsonb THEN RAISE EXCEPTION 'legacy projection changed strings'; END IF;
  SELECT to_jsonb(d) INTO actual FROM experience.extract_chat_history_display(
    '[{"request_id":42,"role":"assistant","content":false},{"request_id":"ignored","role":"assistant","content":"next"}]') d;
  IF actual<>'{"request_id":null,"opening_message":"next"}'::jsonb THEN RAISE EXCEPTION 'legacy type/null semantics changed'; END IF;
  SELECT to_jsonb(d) INTO actual FROM experience.extract_chat_history_display(jsonb_build_array(
    jsonb_build_object('role','assistant','content',U&'\FEFF\00A0hello\3000\2028'))) d;
  IF actual->>'opening_message'<>'hello' THEN RAISE EXCEPTION 'Unicode trim differs from JavaScript'; END IF;

  SELECT id,history INTO hid,original FROM experience.chat_history ORDER BY id LIMIT 1;
  UPDATE experience.chat_history SET history='[]' WHERE id=hid;
  IF (SELECT projection_version FROM experience.chat_history_display_metadata WHERE history_id=hid)<>0 THEN RAISE EXCEPTION 'old writer did not invalidate'; END IF;
  IF NOT (SELECT display_fallback FROM experience.chat_history_display WHERE id=hid) THEN RAISE EXCEPTION 'invalid projection was trusted'; END IF;
  PERFORM experience.backfill_chat_history_display(ARRAY[hid]);
  IF (SELECT display_fallback OR display_opening_message IS NOT NULL OR display_request_id IS NOT NULL FROM experience.chat_history_display WHERE id=hid) THEN
    RAISE EXCEPTION 'known null incorrectly falls back';
  END IF;
  UPDATE experience.chat_history SET history=original WHERE id=hid;

  -- Real admission, frozen prompt and initial replay share the original identity/transaction.
  SELECT * INTO s FROM experience.chat_sessions WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
  INSERT INTO experience.chat_history(user_id,model,user_input,character_id,session_id,turn_index,revision,status)
    VALUES(s.user_id,'synthetic','synthetic',s.character_id,s.id,10001,0,'streaming') RETURNING id INTO hid;
  input:=jsonb_build_object('request_id','70000000-0000-4000-8000-000000000001',
    'primary_attempt_id',gen_random_uuid(),'mode','send','received_at',clock_timestamp(),
    'requested_model_id','synthetic','provider','openrouter','model','synthetic','catalog_version',1,
    'timeout_ms',4000,'deadline_ms',6000,'timeout_rate_target',0.05,
    'charge_id','70000000-0000-4000-8000-000000000002',
    'history','[{"role":"system","content":"","request_id":"70000000-0000-4000-8000-000000000001"}]'::jsonb);
  PERFORM experience.begin_chat_generation_observation(hid,input);
  frozen:=jsonb_build_array(input->'history'->0,jsonb_build_object('role','assistant','content','  frozen opening  '),jsonb_build_object('role','user','content',repeat('synthetic ',10000)));
  PERFORM experience.begin_chat_generation_observation(hid,input||jsonb_build_object('history',frozen,'snapshot',jsonb_build_object('charge_id',input->>'charge_id')));
  PERFORM experience.begin_chat_generation_observation(hid,input);
  IF (SELECT history FROM experience.chat_history WHERE id=hid)<>frozen
    OR (SELECT display_opening_message FROM experience.chat_history_display WHERE id=hid)<>'frozen opening'
    OR (SELECT display_fallback FROM experience.chat_history_display WHERE id=hid) THEN
    RAISE EXCEPTION 'initial replay erased frozen history or its projection';
  END IF;
  IF (SELECT count(*) FROM experience.chat_generation_requests WHERE chat_history_id=hid)<>1 THEN RAISE EXCEPTION 'replay duplicated observation'; END IF;
  BEGIN
    PERFORM experience.begin_chat_generation_observation(hid,input||'{"request_id":"70000000-0000-4000-8000-000000000099"}');
    RAISE EXCEPTION 'mismatched request accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF (SELECT history FROM experience.chat_history WHERE id=hid)<>frozen THEN RAISE EXCEPTION 'failed admission changed prompt'; END IF;
  INSERT INTO experience.chat_history(user_id,model,user_input,character_id,session_id,turn_index,revision,status)
    VALUES(s.user_id,'synthetic','failed admission',s.character_id,s.id,10002,0,'streaming') RETURNING id INTO hid;
  BEGIN
    -- Failure occurs AFTER the history/projection write, in the real request table constraint.
    PERFORM experience.begin_chat_generation_observation(hid,input||'{"mode":"invalid"}');
    RAISE EXCEPTION 'invalid mode accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT history FROM experience.chat_history WHERE id=hid)<>'[]'::jsonb
    OR EXISTS(SELECT 1 FROM experience.chat_history_display_metadata WHERE history_id=hid)
    OR EXISTS(SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=hid) THEN
    RAISE EXCEPTION 'failed observation did not roll back history and projection together';
  END IF;
  BEGIN
    PERFORM experience.list_chat_message_page(gen_random_uuid(),s.id,NULL,25);
    RAISE EXCEPTION 'cross-owner history accepted';
  EXCEPTION WHEN no_data_found THEN NULL; END;
  BEGIN
    PERFORM experience.backfill_chat_history_display(array_fill(hid,ARRAY[101]));
    RAISE EXCEPTION 'unbounded backfill accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF has_table_privilege('anon','experience.chat_history_display_metadata','SELECT')
    OR has_table_privilege('authenticated','experience.session_chat_display','SELECT')
    OR has_function_privilege('anon','experience.list_chat_message_page(uuid,uuid,integer,integer)','EXECUTE')
    OR has_function_privilege('service_role','experience.backfill_chat_history_display(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'display object privileges broadened';
  END IF;
END;
$test$;
SET LOCAL ROLE service_role;
DO $$ DECLARE s record; BEGIN
 SELECT user_id,id INTO s FROM experience.chat_sessions WHERE deleted_at IS NULL LIMIT 1;
 PERFORM experience.list_chat_message_page(s.user_id,s.id,NULL,25);
 PERFORM experience.list_chat_message_page(s.user_id,s.id,0,25);
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'chat display: equivalence, cursor completeness, admission/replay, invalidation and ACL passed' AS result;
