-- Local synthetic users only. No external calls or billing mutations.
INSERT INTO app_core.users(id) VALUES ('10000000-0000-4000-8000-000000000004');
INSERT INTO app_core.characters(id) VALUES ('11000000-0000-4000-8000-000000000004');
INSERT INTO experience.chat_sessions(id,user_id,character_id,title) VALUES
 ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','11000000-0000-4000-8000-000000000004','edit test');
INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,session_id,turn_index,revision,status)
 SELECT '10000000-0000-4000-8000-000000000004','test/model','user-'||n,'reply-'||n,
 '11000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004',n,0,'success' FROM generate_series(1,12) n;
DO $$
DECLARE u uuid:='10000000-0000-4000-8000-000000000004'; s uuid:='20000000-0000-4000-8000-000000000004';
 m uuid; early uuid; last_id uuid; b uuid; b2 uuid; b3 uuid; result jsonb; old_count integer;
BEGIN
 SELECT id INTO m FROM experience.session_chat_history WHERE session_id=s AND turn_index=3;
 SELECT id INTO early FROM experience.session_chat_history WHERE session_id=s AND turn_index=2;
 SELECT id INTO last_id FROM experience.session_chat_history WHERE session_id=s AND turn_index=12;
 SELECT count(*) INTO old_count FROM experience.chat_history;
 b := (experience.fork_chat_session(u,s,last_id,gen_random_uuid(),50)->>'id')::uuid;
 PERFORM experience.change_chat_message(u,s,m,'assistant','edit',0,'new reply');
 PERFORM experience.change_chat_message(u,s,m,'assistant','edit',0,'new reply'); -- response loss replay
 IF (SELECT version FROM experience.chat_message_overrides WHERE session_id=s AND message_id=m AND role='assistant')<>1 THEN RAISE EXCEPTION 'replay double increment'; END IF;
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=b AND turn_index=3)<>'reply-3' THEN RAISE EXCEPTION 'existing branch changed'; END IF;
 IF (SELECT assistant_reply FROM experience.chat_history WHERE id=m)<>'reply-3' THEN RAISE EXCEPTION 'generated fact overwritten'; END IF;
 BEGIN PERFORM experience.change_chat_message(u,s,m,'assistant','edit',0,'stale writer'); RAISE EXCEPTION 'conflict allowed'; EXCEPTION WHEN SQLSTATE 'P0425' THEN NULL; END;
 BEGIN PERFORM experience.change_chat_message(u,s,early,'user','delete',0); RAISE EXCEPTION 'round 11 allowed'; EXCEPTION WHEN SQLSTATE 'P0424' THEN NULL; END;
 BEGIN PERFORM experience.change_chat_message('10000000-0000-4000-8000-000000000003',s,m,'user','delete',0); RAISE EXCEPTION 'other owner allowed'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 PERFORM experience.change_chat_message(u,s,m,'user','delete',0);
 IF (SELECT user_input FROM experience.session_chat_history WHERE session_id=s AND turn_index=3)<>'' THEN RAISE EXCEPTION 'deleted user leaked into context'; END IF;
 b2 := (experience.fork_chat_session(u,s,last_id,gen_random_uuid(),50)->>'id')::uuid;
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=b2 AND turn_index=3)<>'new reply' OR
    NOT (SELECT user_deleted FROM experience.session_chat_history WHERE session_id=b2 AND turn_index=3) THEN RAISE EXCEPTION 'new branch lost effective snapshot'; END IF;
 PERFORM experience.change_chat_message(u,s,m,'assistant','edit',1,'newer reply');
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=b2 AND turn_index=3)<>'new reply' THEN RAISE EXCEPTION 'source edit changed branch'; END IF;
 PERFORM experience.change_chat_message(u,b2,m,'assistant','edit',1,'branch only');
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=s AND turn_index=3)<>'newer reply' THEN RAISE EXCEPTION 'branch edit changed source'; END IF;
 b3 := (experience.fork_chat_session(u,b2,last_id,gen_random_uuid(),50)->>'id')::uuid;
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=b3 AND turn_index=3)<>'branch only' THEN RAISE EXCEPTION 'nested branch lost edit'; END IF;
 PERFORM experience.change_chat_message(u,s,last_id,'assistant','delete',0);
 IF (SELECT assistant_reply FROM experience.session_chat_history WHERE session_id=s AND turn_index=12) IS NOT NULL THEN RAISE EXCEPTION 'deleted assistant leaked'; END IF;
 IF (SELECT user_input FROM experience.session_chat_history WHERE session_id=s AND turn_index=12)<>'user-12' THEN RAISE EXCEPTION 'delete changed unselected message'; END IF;
 IF (SELECT count(*) FROM experience.chat_history)<>old_count THEN RAISE EXCEPTION 'editing created generation facts'; END IF;
 PERFORM experience.change_chat_message(u,s,last_id,'user','delete',0);
 BEGIN PERFORM experience.start_chat_history_regeneration(s,NULL,'test/model',120,75,50); RAISE EXCEPTION 'regenerated deleted input'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 BEGIN PERFORM experience.change_chat_message(u,s,early,'user','delete',0); RAISE EXCEPTION 'deletion unlocked older turn'; EXCEPTION WHEN SQLSTATE 'P0424' THEN NULL; END;
 IF (SELECT max(turn_index) FROM experience.session_chat_history WHERE session_id=s)<>12 THEN RAISE EXCEPTION 'turns renumbered'; END IF;
 -- A saved user edit is used by regeneration, while source facts stay untouched.
 PERFORM experience.change_chat_message(u,b,last_id,'user','edit',0,'changed input');
 result:=experience.start_chat_history_regeneration(b,NULL,'test/model',120,75,50);
 IF result->>'user_content'<>'changed input' THEN RAISE EXCEPTION 'regeneration used stale user input'; END IF;
 BEGIN PERFORM experience.change_chat_message(u,b,m,'user','delete',0); RAISE EXCEPTION 'active generation allowed edit'; EXCEPTION WHEN SQLSTATE '55006' THEN NULL; END;
 IF has_table_privilege('authenticated','experience.chat_message_overrides','SELECT') OR has_table_privilege('service_role','experience.chat_message_overrides','UPDATE') THEN RAISE EXCEPTION 'unexpected direct access'; END IF;
 IF has_function_privilege('anon','experience.change_chat_message(uuid,uuid,uuid,text,text,integer,text)','EXECUTE') THEN RAISE EXCEPTION 'anon can change'; END IF;
END $$;
SELECT 'PASS: single message edits/deletes, ten-round boundary, replay, branch snapshots, context, ownership, busy guard, billing isolation';
