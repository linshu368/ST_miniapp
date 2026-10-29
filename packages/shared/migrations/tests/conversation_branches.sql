-- Isolated synthetic data only; run via scripts/test-conversation-branches-migration.sh.
INSERT INTO app_core.users VALUES('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002'),('10000000-0000-4000-8000-000000000003');
INSERT INTO app_core.characters VALUES('50000000-0000-4000-8000-000000000001');
INSERT INTO experience.chat_sessions(id,user_id,character_id,title,context_window_start_turn) VALUES
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','旅人',151),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','其他用户',1),
('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','并发用户',1);
INSERT INTO experience.chat_history(id,user_id,model,user_input,assistant_reply,history,character_id,session_id,turn_index,revision,status,llm_charge_id,llm_billing_snapshot,llm_billing_settled_at)
SELECT ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'10000000-0000-4000-8000-000000000001','synthetic',
 'question-'||i,'answer-'||i||' [memory]memory-'||i||'[/memory]',
 '[{"role":"assistant","content":"opening"}]'::jsonb,
 '50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',i,0,'success',gen_random_uuid(),'{"billing":"synthetic"}',now()
FROM generate_series(1,200) AS i;
INSERT INTO experience.chat_history(id,user_id,model,user_input,assistant_reply,character_id,session_id,turn_index,revision,status)
VALUES('30000000-0000-4000-8000-000000000301','10000000-0000-4000-8000-000000000003','synthetic','question','answer','50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003',1,0,'success');

DO $$ DECLARE fn record; BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='experience.chat_branch_turns'::regclass) THEN RAISE EXCEPTION 'branch RLS absent'; END IF;
 IF has_table_privilege('anon','experience.chat_branch_turns','SELECT') OR has_table_privilege('authenticated','experience.session_chat_history','SELECT') OR has_table_privilege('service_role','experience.chat_branch_turns','INSERT') THEN RAISE EXCEPTION 'branch table/view privileges too broad'; END IF;
 IF has_function_privilege('anon','experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)','EXECUTE') OR has_function_privilege('authenticated','experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'branch RPC public'; END IF;
 SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig INTO fn FROM pg_proc WHERE oid='experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)'::regprocedure;
 IF NOT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='experience.session_chat_history'::regclass) THEN RAISE EXCEPTION 'overlay is not security invoker'; END IF;
 IF fn.owner<>'postgres' OR NOT fn.prosecdef OR NOT fn.proconfig @> ARRAY['search_path=pg_catalog'] THEN RAISE EXCEPTION 'unsafe branch function'; END IF;
END $$;

SET ROLE service_role;
DO $$
DECLARE early jsonb; recent jsonb; nested jsonb; regenerated jsonb; sent jsonb; replay jsonb; source uuid:='20000000-0000-4000-8000-000000000001'; owner uuid:='10000000-0000-4000-8000-000000000001'; first uuid; last uuid; n integer;
BEGIN
 early:=experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000020','40000000-0000-4000-8000-000000000001',50);
 first:=(early->>'id')::uuid;
 IF early->>'title'<>'分支 · 旅人' OR (early->>'branch_inherited_turns')::int<>20 OR (early->>'context_window_start_turn')::int<>1 OR (early->>'message_count')::int<>40 THEN RAISE EXCEPTION '200 -> 20 branch metadata wrong'; END IF;
 IF (SELECT array_agg(user_input ORDER BY turn_index) FROM experience.session_chat_history WHERE session_id=first) <> ARRAY(SELECT 'question-'||i FROM generate_series(1,20) i) THEN RAISE EXCEPTION 'early context polluted'; END IF;
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=first ORDER BY turn_index DESC LIMIT 1)<>'answer-20 [memory]memory-20[/memory]' THEN RAISE EXCEPTION 'branch lost embedded memory'; END IF;
 IF (SELECT count(*) FROM experience.chat_history WHERE user_id=owner)<>200 OR EXISTS(SELECT 1 FROM experience.chat_history WHERE session_id=first) THEN RAISE EXCEPTION 'fork duplicated generation/billing history'; END IF;
 IF EXISTS(SELECT 1 FROM experience.session_chat_history WHERE session_id=first AND llm_charge_id IS NOT NULL) THEN RAISE EXCEPTION 'inherited billing identity exposed'; END IF;
 replay:=experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000020','40000000-0000-4000-8000-000000000001',50);
 IF replay->>'id'<>early->>'id' THEN RAISE EXCEPTION 'request replay created another session'; END IF;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000060','40000000-0000-4000-8000-000000000001',50);
  RAISE EXCEPTION 'request identity mismatch accepted';
 EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL; END;
 BEGIN
  PERFORM experience.fork_chat_session('10000000-0000-4000-8000-000000000002',source,'30000000-0000-4000-8000-000000000020',gen_random_uuid(),50);
  RAISE EXCEPTION 'cross-owner branch accepted';
 EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000301',gen_random_uuid(),50);
  RAISE EXCEPTION 'cross-session message accepted';
 EXCEPTION WHEN SQLSTATE 'P0422' THEN NULL; END;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000020',gen_random_uuid(),1001);
  RAISE EXCEPTION 'unbounded retained count accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

 recent:=experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000060','40000000-0000-4000-8000-000000000002',50);
 last:=(recent->>'id')::uuid;
 IF (SELECT array_agg(user_input ORDER BY turn_index) FROM experience.session_chat_history WHERE session_id=last) <> ARRAY(SELECT 'question-'||i FROM generate_series(11,60) i) THEN RAISE EXCEPTION '200 -> 60 not latest50'; END IF;
 IF (SELECT min(turn_index) FROM experience.session_chat_history WHERE session_id=last)<>1 OR (SELECT max(turn_index) FROM experience.session_chat_history WHERE session_id=last)<>50 THEN RAISE EXCEPTION 'branch turn allocation is not local'; END IF;
 IF (SELECT history->0->>'content' FROM experience.session_chat_history WHERE session_id=last AND turn_index=1)<>'opening' THEN RAISE EXCEPTION 'opening snapshot lost'; END IF;
 nested:=experience.fork_chat_session(owner,last,'30000000-0000-4000-8000-000000000030','40000000-0000-4000-8000-000000000003',50);
 IF nested->>'title'<>'分支 · 旅人' OR (nested->>'branch_source_turn_index')::int<>20 OR (nested->>'branch_inherited_turns')::int<>20 THEN RAISE EXCEPTION 'nested metadata wrong'; END IF;
 IF (SELECT array_agg(user_input ORDER BY turn_index) FROM experience.session_chat_history WHERE session_id=(nested->>'id')::uuid) <> ARRAY(SELECT 'question-'||i FROM generate_series(11,30) i) THEN RAISE EXCEPTION 'nested inherits future turns'; END IF;

 -- Original's newly chosen revision cannot rewrite the branch's frozen ID.
 INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,history,character_id,session_id,turn_index,revision,status)
 SELECT user_id,model,user_input,'changed source answer',history,character_id,session_id,turn_index,1,status FROM experience.chat_history WHERE id='30000000-0000-4000-8000-000000000020';
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=first AND turn_index=20)<>'answer-20 [memory]memory-20[/memory]' THEN RAISE EXCEPTION 'source regen mutated branch'; END IF;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000020',gen_random_uuid(),50);
  RAISE EXCEPTION 'obsolete source revision accepted';
 EXCEPTION WHEN SQLSTATE 'P0422' THEN NULL; END;

 -- Existing full wrappers bind current postprocess and slot modes for inherited regeneration.
 regenerated:=experience.start_chat_history_regeneration_with_current_postprocess(first,NULL,'synthetic',120,75,50);
 IF (regenerated->>'turn_index')::int<>20 OR (regenerated->>'revision')::int<>1 OR regenerated->>'user_content'<>'question-20' OR (regenerated->>'postprocess_version')::int<>1 OR regenerated->>'memory_rules_mode'<>'full' THEN RAISE EXCEPTION 'inherited regeneration broke wrapper contract'; END IF;
 UPDATE experience.chat_history SET status='success',assistant_reply='branch regenerated' WHERE id=(regenerated->>'history_id')::uuid;
 IF (SELECT count(*) FROM experience.session_chat_history WHERE session_id=first)<>20 OR (SELECT is_inherited FROM experience.session_chat_history WHERE session_id=first AND turn_index=20) THEN RAISE EXCEPTION 'local revision did not override inherited'; END IF;
 IF (SELECT message_count FROM experience.chat_sessions WHERE id=first)<>40 THEN RAISE EXCEPTION 'regeneration double-counted inherited turn'; END IF;

 sent:=experience.start_chat_history_turn_with_current_postprocess(first,'continue branch','synthetic',120,75,50);
 IF (sent->>'turn_index')::int<>21 THEN RAISE EXCEPTION 'branch continuation starts at wrong turn'; END IF;
 UPDATE experience.chat_history SET status='success',assistant_reply='continued branch' WHERE id=(sent->>'history_id')::uuid;
 IF (SELECT message_count FROM experience.chat_sessions WHERE id=first)<>42 THEN RAISE EXCEPTION 'continued session count wrong'; END IF;
 IF (SELECT count(*) FROM experience.current_chat_history WHERE session_id=first)<>2 THEN RAISE EXCEPTION 'current generation view includes inherited rows'; END IF;

 FOR n IN 51..77 LOOP
  sent:=experience.start_chat_history_turn_with_current_postprocess(last,'new-'||n,'synthetic',120,75,50);
  IF (sent->>'turn_index')::int<>n THEN RAISE EXCEPTION 'branch window turn allocation wrong'; END IF;
  IF n<=76 AND (sent->>'context_window_start_turn')::int<>1 THEN RAISE EXCEPTION 'context truncated before high watermark'; END IF;
  IF n=77 AND (sent->>'context_window_start_turn')::int<>27 THEN RAISE EXCEPTION 'context did not retain50 after75'; END IF;
  UPDATE experience.chat_history SET status='success',assistant_reply='new-answer-'||n WHERE id=(sent->>'history_id')::uuid;
 END LOOP;
 IF (SELECT count(*) FROM experience.session_chat_history WHERE session_id=last AND turn_index>=27 AND turn_index<77)<>50 THEN RAISE EXCEPTION 'post-flood context wrong'; END IF;

 UPDATE experience.chat_sessions SET deleted_at=now() WHERE id=source;
 IF (SELECT count(*) FROM experience.session_chat_history WHERE session_id=first)<>21 THEN RAISE EXCEPTION 'source soft delete removed branch'; END IF;
 replay:=experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000020','40000000-0000-4000-8000-000000000001',50);
 IF replay->>'id'<>early->>'id' THEN RAISE EXCEPTION 'replay after source delete failed'; END IF;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000060',gen_random_uuid(),50);
  RAISE EXCEPTION 'deleted source allowed new branch';
 EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 UPDATE experience.chat_sessions SET deleted_at=NULL WHERE id=source;

 -- Ordinary empty sessions retain their old 1-based behavior.
 INSERT INTO experience.chat_sessions(user_id,character_id,title) VALUES(owner,'50000000-0000-4000-8000-000000000001','ordinary') RETURNING id INTO first;
 sent:=experience.start_chat_history_turn_with_current_postprocess(first,'ordinary first','synthetic',120,75,50);
 IF (sent->>'turn_index')::int<>1 OR (sent->>'context_window_start_turn')::int<>1 THEN RAISE EXCEPTION 'ordinary chat changed'; END IF;
 UPDATE experience.chat_history SET status='success',assistant_reply='ordinary' WHERE id=(sent->>'history_id')::uuid;
 regenerated:=experience.start_chat_history_regeneration_with_current_postprocess(first,NULL,'synthetic',120,75,50);
 IF (regenerated->>'turn_index')::int<>1 OR (regenerated->>'revision')::int<>1 OR regenerated->>'user_content'<>'ordinary first' THEN RAISE EXCEPTION 'ordinary regeneration changed'; END IF;
 UPDATE experience.chat_history SET status='success',assistant_reply='ordinary regenerated' WHERE id=(regenerated->>'history_id')::uuid;

 -- Streaming/failed/empty target replies are rejected; no empty half-created session.
 FOR n IN 1..3 LOOP
  INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,session_id,turn_index,revision,status)
  VALUES(owner,'synthetic','invalid',CASE WHEN n=3 THEN '' ELSE 'unfinished' END,'50000000-0000-4000-8000-000000000001',first,n+1,0,CASE n WHEN 1 THEN 'streaming' WHEN 2 THEN 'failed' ELSE 'success' END) RETURNING id INTO last;
  BEGIN
   PERFORM experience.fork_chat_session(owner,first,last,gen_random_uuid(),50);
   RAISE EXCEPTION 'non-complete/empty branch target accepted';
  EXCEPTION WHEN SQLSTATE 'P0422' THEN NULL; END;
 END LOOP;

 -- Soft-deleted branches still count toward a short creation burst and stay deleted on retry.
 WHILE (SELECT count(*) FROM experience.chat_sessions WHERE user_id=owner AND branch_request_id IS NOT NULL AND created_at>=now()-interval '1 minute')<10 LOOP
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000060',gen_random_uuid(),1);
 END LOOP;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000060',gen_random_uuid(),1);
  RAISE EXCEPTION 'rate limit absent';
 EXCEPTION WHEN SQLSTATE 'P0429' THEN NULL; END;
 UPDATE experience.chat_sessions SET deleted_at=now() WHERE id=(early->>'id')::uuid;
 BEGIN
  PERFORM experience.fork_chat_session(owner,source,'30000000-0000-4000-8000-000000000020','40000000-0000-4000-8000-000000000001',50);
  RAISE EXCEPTION 'idempotent replay resurrected deleted branch';
 EXCEPTION WHEN SQLSTATE 'P0422' THEN NULL; END;
END $$;
RESET ROLE;
-- A failure after session INSERT rolls back the whole branch, not a half-created row.
CREATE FUNCTION experience.reject_branch_reference_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'synthetic branch reference failure' USING ERRCODE='P9999'; END $$;
CREATE TRIGGER reject_branch_reference_for_test BEFORE INSERT ON experience.chat_branch_turns
FOR EACH STATEMENT EXECUTE FUNCTION experience.reject_branch_reference_for_test();
DO $$ BEGIN
 BEGIN
  PERFORM experience.fork_chat_session('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000301','40000000-0000-4000-8000-000000000098',50);
  RAISE EXCEPTION 'synthetic failure was not injected';
 EXCEPTION WHEN SQLSTATE 'P9999' THEN NULL; END;
 IF EXISTS(SELECT 1 FROM experience.chat_sessions WHERE branch_request_id='40000000-0000-4000-8000-000000000098') THEN RAISE EXCEPTION 'failed fork left a partial session'; END IF;
END $$;
DROP TRIGGER reject_branch_reference_for_test ON experience.chat_branch_turns;
DROP FUNCTION experience.reject_branch_reference_for_test();
DO $$ BEGIN
 BEGIN
  DELETE FROM experience.chat_history WHERE id='30000000-0000-4000-8000-000000000020';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'inherited source history was physically pruned';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE experience.chat_sessions SET branch_source_turn_index=NULL WHERE branch_request_id='40000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'branch allowed a missing anchor turn';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
-- Planner check for the inherited leg: both branch session and source history
-- have usable indexes; no requirement to load every source prompt. Tiny synthetic
-- data may normally prefer a scan, so this tests index eligibility, not prod latency.
DO $$ DECLARE plan json; branch uuid; BEGIN
 SELECT id INTO branch FROM experience.chat_sessions WHERE branch_request_id='40000000-0000-4000-8000-000000000002';
 PERFORM set_config('enable_seqscan','off',true);
 EXECUTE format('EXPLAIN (FORMAT JSON) SELECT id,user_input,history->0,history->1 FROM experience.session_chat_history WHERE session_id=%L::uuid AND turn_index<51 ORDER BY turn_index DESC LIMIT 26',branch) INTO plan;
 IF plan::text NOT LIKE '%chat_branch_turns_pkey%' OR plan::text NOT LIKE '%chat_history_pkey%' OR plan::text NOT LIKE '%Index Cond%' THEN
  RAISE EXCEPTION 'branch overlay lost indexed session/source lookup: %',plan;
 END IF;
END $$;
SELECT 'PASS: sequential conversation branch and existing generation contracts' AS result;

-- Reply feedback extends this same acceptance fixture, without another database.
DO $$ DECLARE fn record; role_name text; BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='experience.chat_message_likes'::regclass) THEN RAISE EXCEPTION 'reply like RLS absent'; END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_table_privilege(role_name,'experience.chat_message_likes','SELECT,INSERT,UPDATE,DELETE')
     OR has_function_privilege(role_name,'experience.set_chat_message_like(uuid,uuid,uuid,boolean)','EXECUTE') THEN RAISE EXCEPTION 'reply likes publicly accessible'; END IF;
 END LOOP;
 IF NOT has_table_privilege('service_role','experience.chat_message_likes','SELECT')
    OR has_table_privilege('service_role','experience.chat_message_likes','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'reply like service table privileges wrong'; END IF;
 SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig INTO fn FROM pg_proc WHERE oid='experience.set_chat_message_like(uuid,uuid,uuid,boolean)'::regprocedure;
 IF fn.owner<>'postgres' OR NOT fn.prosecdef OR NOT fn.proconfig @> ARRAY['search_path=pg_catalog','lock_timeout=3s','statement_timeout=5s'] THEN RAISE EXCEPTION 'reply like RPC security/budget wrong'; END IF;
 IF (SELECT attname FROM pg_attribute WHERE attrelid='experience.session_chat_history'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum DESC LIMIT 1)<>'liked' THEN RAISE EXCEPTION 'liked is not the appended column'; END IF;
END $$;
SET ROLE service_role;
DO $$
DECLARE
 owner uuid:='10000000-0000-4000-8000-000000000002'; source uuid:='20000000-0000-4000-8000-000000000002';
 message uuid:='30000000-0000-4000-8000-000000000401'; second_message uuid:='30000000-0000-4000-8000-000000000402';
 branch uuid; nested uuid; result jsonb; regenerated jsonb; source_before jsonb; history_before integer; liked_at timestamptz; invalid_message uuid; n integer;
BEGIN
 INSERT INTO experience.chat_history(id,user_id,model,user_input,assistant_reply,character_id,session_id,turn_index,revision,status)
 SELECT ('30000000-0000-4000-8000-'||lpad((400+i)::text,12,'0'))::uuid,owner,'synthetic','like-question-'||i,'like-answer-'||i,'50000000-0000-4000-8000-000000000001',source,i,0,'success' FROM generate_series(1,2) i;
 SELECT to_jsonb(s) INTO source_before FROM experience.chat_sessions s WHERE id=source;
 SELECT count(*) INTO history_before FROM experience.chat_history;
 IF EXISTS(SELECT 1 FROM experience.session_chat_history WHERE session_id=source AND liked) THEN RAISE EXCEPTION 'new reply already liked'; END IF;
 result:=experience.set_chat_message_like(owner,source,message,true);
 IF result<>jsonb_build_object('session_id',source,'message_id',message,'liked',true) OR NOT (SELECT liked FROM experience.session_chat_history WHERE session_id=source AND id=message) THEN RAISE EXCEPTION 'reply like not persisted/projected'; END IF;
 SELECT created_at INTO liked_at FROM experience.chat_message_likes WHERE session_id=source AND message_id=message;
 PERFORM experience.set_chat_message_like(owner,source,message,true);
 IF (SELECT count(*) FROM experience.chat_message_likes WHERE session_id=source AND message_id=message)<>1 OR (SELECT created_at FROM experience.chat_message_likes WHERE session_id=source AND message_id=message)<>liked_at THEN RAISE EXCEPTION 'duplicate like not idempotent'; END IF;
 PERFORM experience.set_chat_message_like(owner,source,message,false);
 PERFORM experience.set_chat_message_like(owner,source,message,false);
 IF (SELECT liked FROM experience.session_chat_history WHERE session_id=source AND id=message) THEN RAISE EXCEPTION 'unlike not persisted'; END IF;
 IF (SELECT to_jsonb(s) FROM experience.chat_sessions s WHERE id=source) IS DISTINCT FROM source_before OR (SELECT count(*) FROM experience.chat_history)<>history_before THEN RAISE EXCEPTION 'reply feedback touched generation/session stats'; END IF;
 BEGIN
  INSERT INTO experience.chat_message_likes(session_id,message_id) VALUES(source,message);
  RAISE EXCEPTION 'direct service write allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM experience.set_chat_message_like('10000000-0000-4000-8000-000000000001',source,message,true);
  RAISE EXCEPTION 'other user can like a reply';
 EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 BEGIN
  PERFORM experience.set_chat_message_like(owner,source,'30000000-0000-4000-8000-000000000301',true);
  RAISE EXCEPTION 'reply from another session accepted';
 EXCEPTION WHEN SQLSTATE 'P0423' THEN NULL; END;
 BEGIN
  PERFORM experience.set_chat_message_like(owner,source,message,NULL);
  RAISE EXCEPTION 'null like accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

 PERFORM experience.set_chat_message_like(owner,source,message,true);
 result:=experience.fork_chat_session(owner,source,message,'40000000-0000-4000-8000-000000000201',50);
 branch:=(result->>'id')::uuid;
 IF (SELECT liked FROM experience.session_chat_history WHERE session_id=branch AND id=message) THEN RAISE EXCEPTION 'source like copied to branch'; END IF;
 PERFORM experience.set_chat_message_like(owner,branch,message,true);
 PERFORM experience.set_chat_message_like(owner,source,message,false);
 IF NOT (SELECT liked FROM experience.session_chat_history WHERE session_id=branch AND id=message) OR (SELECT liked FROM experience.session_chat_history WHERE session_id=source AND id=message) THEN RAISE EXCEPTION 'branch like shares source state'; END IF;
 result:=experience.fork_chat_session(owner,branch,message,'40000000-0000-4000-8000-000000000202',50);
 nested:=(result->>'id')::uuid;
 IF (SELECT liked FROM experience.session_chat_history WHERE session_id=nested AND id=message) THEN RAISE EXCEPTION 'nested branch copied like'; END IF;
 regenerated:=experience.start_chat_history_regeneration_with_current_postprocess(branch,NULL,'synthetic',120,75,50);
 UPDATE experience.chat_history SET status='success',assistant_reply='new branch version' WHERE id=(regenerated->>'history_id')::uuid;
 IF (SELECT liked FROM experience.session_chat_history WHERE session_id=branch AND id=(regenerated->>'history_id')::uuid) OR NOT EXISTS(SELECT 1 FROM experience.chat_message_likes WHERE session_id=branch AND message_id=message) THEN RAISE EXCEPTION 'branch regenerated version inherited/erased old like'; END IF;
 BEGIN
  PERFORM experience.set_chat_message_like(owner,branch,message,false);
  RAISE EXCEPTION 'stale inherited revision still writable';
 EXCEPTION WHEN SQLSTATE 'P0423' THEN NULL; END;

 PERFORM experience.set_chat_message_like(owner,source,second_message,true);
 regenerated:=experience.start_chat_history_regeneration_with_current_postprocess(source,NULL,'synthetic',120,75,50);
 UPDATE experience.chat_history SET status='success',assistant_reply='new original version' WHERE id=(regenerated->>'history_id')::uuid;
 IF (SELECT liked FROM experience.session_chat_history WHERE session_id=source AND id=(regenerated->>'history_id')::uuid) OR NOT EXISTS(SELECT 1 FROM experience.chat_message_likes WHERE session_id=source AND message_id=second_message) THEN RAISE EXCEPTION 'normal regenerated version inherited/erased old like'; END IF;
 BEGIN
  PERFORM experience.set_chat_message_like(owner,source,second_message,true);
  RAISE EXCEPTION 'stale original revision still writable';
 EXCEPTION WHEN SQLSTATE 'P0423' THEN NULL; END;
 DELETE FROM experience.chat_history WHERE id=second_message;
 IF EXISTS(SELECT 1 FROM experience.chat_message_likes WHERE message_id=second_message) THEN RAISE EXCEPTION 'history delete did not cascade reply like'; END IF;

 FOR n IN 1..3 LOOP
  INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,session_id,turn_index,revision,status)
  VALUES(owner,'synthetic','invalid',CASE WHEN n=3 THEN ' ' ELSE 'unfinished' END,'50000000-0000-4000-8000-000000000001',source,n+2,0,CASE n WHEN 1 THEN 'streaming' WHEN 2 THEN 'failed' ELSE 'success' END) RETURNING id INTO invalid_message;
  BEGIN
   PERFORM experience.set_chat_message_like(owner,source,invalid_message,true);
   RAISE EXCEPTION 'unfinished/empty reply accepted';
  EXCEPTION WHEN SQLSTATE 'P0423' THEN NULL; END;
 END LOOP;
 PERFORM experience.set_chat_message_like(owner,source,message,true);
 UPDATE experience.chat_sessions SET deleted_at=now() WHERE id=source;
 BEGIN
  PERFORM experience.set_chat_message_like(owner,source,message,false);
  RAISE EXCEPTION 'deleted session accepted reply feedback';
 EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 PERFORM experience.set_chat_message_like(owner,nested,message,true);
 IF NOT (SELECT liked FROM experience.session_chat_history WHERE session_id=nested AND id=message) THEN RAISE EXCEPTION 'deleted source disabled branch feedback'; END IF;
 DELETE FROM experience.chat_sessions WHERE id=source;
 IF EXISTS(SELECT 1 FROM experience.chat_message_likes WHERE session_id=source) THEN RAISE EXCEPTION 'session delete did not cascade likes'; END IF;
 IF NOT (SELECT liked FROM experience.session_chat_history WHERE session_id=nested AND id=message) THEN RAISE EXCEPTION 'source hard-delete changed independent branch feedback'; END IF;
END $$;
RESET ROLE;
DO $$ DECLARE plan json; BEGIN
 EXECUTE 'EXPLAIN (FORMAT JSON) SELECT id,user_input,history->0,history->1 FROM experience.session_chat_history WHERE session_id=''20000000-0000-4000-8000-000000000001''::uuid ORDER BY turn_index DESC LIMIT 26' INTO plan;
 IF plan::text LIKE '%chat_message_likes%' THEN RAISE EXCEPTION 'context projection unnecessarily reads reply feedback'; END IF;
END $$;
SELECT 'PASS: reply likes (idempotency, permissions, revision/branch isolation, session independence, cascades, context projection)' AS result;

SET ROLE service_role;
DO $$
DECLARE owner uuid:='10000000-0000-4000-8000-000000000003'; source uuid:='20000000-0000-4000-8000-000000000003';
 character uuid:='50000000-0000-4000-8000-000000000001'; second_character uuid:='50000000-0000-4000-8000-000000000002';
 first_message uuid:='30000000-0000-4000-8000-000000000301'; second_message uuid:='30000000-0000-4000-8000-000000000302';
 baseline bigint; social record; result jsonb; branch uuid;
BEGIN
 INSERT INTO app_core.characters(id) VALUES(second_character);
 INSERT INTO experience.chat_history(id,user_id,model,user_input,assistant_reply,character_id,session_id,turn_index,revision,status)
 VALUES(second_message,owner,'synthetic','second question','second reply',character,source,2,0,'success');
 SELECT like_count INTO baseline FROM miniapp_features.get_character_socials(ARRAY[character],owner);
 SELECT * INTO social FROM miniapp_features.set_character_like(character,owner,true);
 IF NOT social.liked OR social.like_count<>baseline+1 THEN RAISE EXCEPTION 'direct card like no longer counts'; END IF;
 PERFORM miniapp_features.set_character_like(character,owner,true);
 PERFORM experience.set_chat_message_like(owner,source,first_message,true);
 PERFORM experience.set_chat_message_like(owner,source,first_message,true);
 SELECT * INTO social FROM miniapp_features.get_character_socials(ARRAY[character],owner);
 IF NOT social.liked OR social.like_count<>baseline+2 THEN RAISE EXCEPTION 'reply count or duplicate behavior wrong'; END IF;
 PERFORM experience.set_chat_message_like(owner,source,second_message,true);
 IF (SELECT like_count FROM miniapp_features.get_character_socials(ARRAY[character],owner))<>baseline+3 THEN RAISE EXCEPTION 'different replies did not accumulate'; END IF;
 PERFORM experience.set_chat_message_like(owner,source,first_message,false);
 SELECT * INTO social FROM miniapp_features.set_character_like(character,owner,false);
 IF social.liked OR social.like_count<>baseline+1 THEN RAISE EXCEPTION 'card/reply unlike states not independent'; END IF;
 result:=experience.fork_chat_session(owner,source,second_message,'40000000-0000-4000-8000-000000000303',50);
 branch:=(result->>'id')::uuid;
 IF (SELECT like_count FROM miniapp_features.get_character_socials(ARRAY[character],owner))<>baseline+1 THEN RAISE EXCEPTION 'fork invented likes'; END IF;
 PERFORM experience.set_chat_message_like(owner,branch,second_message,true);
 IF (SELECT like_count FROM miniapp_features.get_character_socials(ARRAY[character],owner))<>baseline+2 THEN RAISE EXCEPTION 'explicit branch like not counted'; END IF;
 PERFORM experience.set_chat_message_like(owner,branch,second_message,false);
 result:=experience.start_chat_history_regeneration_with_current_postprocess(source,NULL,'synthetic',120,75,50);
 UPDATE experience.chat_history SET status='success',assistant_reply='regenerated reply' WHERE id=(result->>'history_id')::uuid;
 IF (SELECT like_count FROM miniapp_features.get_character_socials(ARRAY[character],owner))<>baseline+1 THEN RAISE EXCEPTION 'regeneration removed explicit old-version feedback'; END IF;
 PERFORM experience.set_chat_message_like(owner,source,(result->>'history_id')::uuid,true);
 IF (SELECT like_count FROM miniapp_features.get_character_socials(ARRAY[character],owner))<>baseline+2 THEN RAISE EXCEPTION 'new revision explicit like not counted'; END IF;
 IF (SELECT count(*) FROM miniapp_features.get_character_socials(ARRAY[character,character,second_character],owner))<>2
    OR (SELECT like_count FROM miniapp_features.get_character_socials(ARRAY[second_character],owner))<>0 THEN RAISE EXCEPTION 'batch totals duplicated or crossed characters'; END IF;
 IF has_function_privilege('anon','experience.get_character_reply_like_counts(uuid[])','EXECUTE')
    OR has_function_privilege('authenticated','experience.get_character_reply_like_counts(uuid[])','EXECUTE') THEN RAISE EXCEPTION 'count accessor publicly executable'; END IF;
 BEGIN
  PERFORM experience.get_character_reply_like_counts(ARRAY[]::uuid[]);
  RAISE EXCEPTION 'empty batch accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
RESET ROLE;
SELECT 'PASS: character totals combine direct card and all explicit reply likes without copying feedback' AS result;
