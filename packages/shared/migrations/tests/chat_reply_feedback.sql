-- Synthetic data; run only in the disposable PG17 acceptance database.
INSERT INTO app_core.users(id) VALUES ('10000000-0000-4000-8000-000000000005');
INSERT INTO app_core.characters(id) VALUES ('11000000-0000-4000-8000-000000000005');
INSERT INTO experience.chat_sessions(id,user_id,character_id,title) VALUES
 ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000005','11000000-0000-4000-8000-000000000005','feedback');
INSERT INTO experience.chat_history(id,user_id,character_id,session_id,model,user_input,assistant_reply,status,turn_index,revision,llm_billing_snapshot)
SELECT ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'10000000-0000-4000-8000-000000000005','11000000-0000-4000-8000-000000000005',
 '20000000-0000-4000-8000-000000000005','test/model','question-'||i,'reply-'||i,'success',i,1,'{"provider":"openrouter","provider_model_id":"test/upstream"}'::jsonb
FROM generate_series(501,540) i;
DO $$
DECLARE u uuid := '10000000-0000-4000-8000-000000000005'; s uuid := '20000000-0000-4000-8000-000000000005';
 m uuid := '30000000-0000-4000-8000-000000000540'; result jsonb; again jsonb; branch uuid; before_rows integer;
BEGIN
 SELECT count(*) INTO before_rows FROM experience.chat_history;
 IF experience.get_chat_reply_feedback(u,s,m,0)->'feedback'<>'null'::jsonb THEN RAISE EXCEPTION 'new feedback should be empty'; END IF;
 result := experience.save_chat_reply_feedback(u,s,m,0,'{}','');
 again := experience.save_chat_reply_feedback(u,s,m,0,'{}','');
 IF result<>again THEN RAISE EXCEPTION 'empty replay changed identity/timestamps'; END IF;
 IF (SELECT count(*) FROM experience.chat_reply_feedback WHERE session_id=s)<>1 THEN RAISE EXCEPTION 'duplicate vote'; END IF;
 IF (SELECT assistant_reply FROM experience.chat_reply_feedback WHERE session_id=s)<>'reply-540' THEN RAISE EXCEPTION 'wrong snapshot'; END IF;
 IF (SELECT provider FROM experience.chat_reply_feedback WHERE session_id=s)<>'openrouter' THEN RAISE EXCEPTION 'wrong provider'; END IF;
 BEGIN PERFORM experience.save_chat_reply_feedback('10000000-0000-4000-8000-000000000003',s,m,0,'{}',''); RAISE EXCEPTION 'other owner writes'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 BEGIN PERFORM experience.get_chat_reply_feedback('10000000-0000-4000-8000-000000000003',s,m,0); RAISE EXCEPTION 'other owner reads'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 BEGIN PERFORM experience.save_chat_reply_feedback(u,s,m,99,'{}',''); RAISE EXCEPTION 'stale version accepted'; EXCEPTION WHEN SQLSTATE 'P0426' THEN NULL; END;
 BEGIN PERFORM experience.save_chat_reply_feedback(u,s,m,0,ARRAY['unknown'],''); RAISE EXCEPTION 'invalid reason accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM experience.save_chat_reply_feedback(u,s,m,0,'{}',repeat('x',501)); RAISE EXCEPTION 'long detail accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM experience.change_chat_message(u,s,m,'assistant','edit',0,'edited reply');
 PERFORM experience.save_chat_reply_feedback(u,s,m,1,ARRAY['lacks_tension'],'detail');
 IF (SELECT count(*) FROM experience.chat_reply_feedback WHERE session_id=s)<>2 THEN RAISE EXCEPTION 'edit version not separate'; END IF;
 IF (SELECT assistant_reply FROM experience.chat_reply_feedback WHERE session_id=s AND edit_version=0)<>'reply-540' THEN RAISE EXCEPTION 'old evidence overwritten'; END IF;
 IF (SELECT assistant_reply FROM experience.chat_reply_feedback WHERE session_id=s AND edit_version=1)<>'edited reply' THEN RAISE EXCEPTION 'edited evidence missing'; END IF;
 branch := (experience.fork_chat_session(u,s,m,gen_random_uuid(),50)->>'id')::uuid;
 PERFORM experience.save_chat_reply_feedback(u,branch,m,1,'{}','branch');
 IF NOT(SELECT is_inherited FROM experience.chat_reply_feedback WHERE session_id=branch) THEN RAISE EXCEPTION 'branch provenance lost'; END IF;
 PERFORM experience.change_chat_message(u,s,m,'assistant','delete',1);
 PERFORM experience.save_chat_reply_feedback(u,s,m,1,ARRAY['lacks_tension'],'detail');
 BEGIN PERFORM experience.save_chat_reply_feedback(u,s,m,2,'{}',''); RAISE EXCEPTION 'deleted reply accepted'; EXCEPTION WHEN SQLSTATE 'P0426' THEN NULL; END;
 IF (SELECT count(*) FROM experience.chat_history)<>before_rows THEN RAISE EXCEPTION 'feedback changed generation rows'; END IF;
 IF has_table_privilege('anon','experience.chat_reply_feedback','SELECT') OR has_table_privilege('authenticated','experience.chat_reply_feedback','SELECT') OR has_table_privilege('service_role','experience.chat_reply_feedback','INSERT') THEN RAISE EXCEPTION 'feedback permissions too wide'; END IF;
 IF NOT(SELECT relrowsecurity FROM pg_class WHERE oid='experience.chat_reply_feedback'::regclass) THEN RAISE EXCEPTION 'RLS missing'; END IF;
 IF has_function_privilege('authenticated','experience.save_chat_reply_feedback(uuid,uuid,uuid,integer,text[],text)','EXECUTE') OR has_function_privilege('anon','experience.get_chat_reply_feedback(uuid,uuid,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'client can call privileged RPC'; END IF;
END $$;
-- Exercise RPC as the actual non-superuser runtime role.
SET ROLE service_role;
SELECT experience.save_chat_reply_feedback('10000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000539',0,'{}','');
RESET ROLE;
SELECT 'PASS: private feedback empty submit, replay, edited/branch snapshots, ownership, RLS/grants, no generation writes';
