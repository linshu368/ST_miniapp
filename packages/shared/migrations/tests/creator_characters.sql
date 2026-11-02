-- Isolated synthetic fixtures only; exercised by scripts/test-creator-characters-local.sh.
DO $$ BEGIN
 IF current_database() NOT LIKE 'creator_core_test_%' THEN RAISE EXCEPTION 'disposable creator test database required'; END IF;
END $$;
DO $test$
DECLARE
 owner_id uuid:='10000000-0000-4000-8000-000000000001';
 viewer_id uuid:='10000000-0000-4000-8000-000000000002';
 outsider_id uuid:='10000000-0000-4000-8000-000000000003';
 admin_id uuid:='10000000-0000-4000-8000-000000000004';
 cover_id uuid:='10000000-0000-4000-8000-000000000005';
 card_id uuid:='10000000-0000-4000-8000-000000000006';
 s_empty uuid:=gen_random_uuid(); s_a uuid:=gen_random_uuid(); s_owner uuid:=gen_random_uuid(); s_rollback uuid:=gen_random_uuid();
 official_id uuid:=gen_random_uuid(); s_official uuid:=gen_random_uuid();
 r jsonb; d jsonb; runtime jsonb; payload jsonb; turn jsonb; branch jsonb; large_import jsonb;
 frozen_a uuid; frozen_b uuid; owner_frozen uuid; expected integer;
BEGIN
 ASSERT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app_core.characters'::regclass AND attisdropped),
   'fixture must retain historical dropped column slots';
 SELECT jsonb_build_object('fixture','synthetic-only','entries',jsonb_agg(jsonb_build_object('id',n,'content',repeat(md5(n::text),64))))
 INTO large_import FROM generate_series(1,128) n;
 ASSERT octet_length(large_import::text)>250000,'fixture must exercise large imported JSON';
 INSERT INTO app_core.users(id) VALUES(owner_id),(viewer_id),(outsider_id);
 INSERT INTO admin.admin_users VALUES(admin_id,'fixture@example.invalid','operator',true,false);
 INSERT INTO app_core.character_cover_assets VALUES(cover_id,owner_id,'fixture/cover.png','image/png',100,100,100,now());
 d:=jsonb_build_object('name','角色A','description','简介A','opening','开场A','background','背景A','preset','预设',
 'tags',jsonb_build_array('日常'),'backgroundFiles','[]'::jsonb,'presetFiles','[]'::jsonb);
 runtime:=jsonb_build_object('name','角色A','description','简介A','first_mes','开场A','system_prompt','prompt A');
 payload:=jsonb_build_object('draft',d,'runtime',runtime,'cover_asset_id',cover_id);
 r:=app_core.mutate_creator_character(owner_id,card_id,'create',NULL,payload);
 UPDATE app_core.characters SET character_persona_and_style='creator fixture persona',raw_card=large_import,
   character_book=large_import,extensions='{"fixture":{"enabled":true}}',alternate_greetings='["备选开场"]'
 WHERE id=card_id;
 ASSERT (r->>'revision')::integer=1;
 ASSERT app_core.mutate_creator_character(owner_id,card_id,'create',NULL,payload)=r,'create replay changed draft';
 BEGIN
  PERFORM app_core.mutate_creator_character(viewer_id,card_id,'create',NULL,payload);
  RAISE EXCEPTION 'other owner accepted';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 ASSERT app_core.can_use_character(owner_id,card_id) AND NOT app_core.can_use_character(viewer_id,card_id);
 ASSERT NOT app_core.can_discover_character(card_id);
 BEGIN
  PERFORM app_core.grant_creator_character_access(viewer_id,card_id);
  RAISE EXCEPTION 'private guessed ID accepted';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 r:=app_core.mutate_creator_character(owner_id,card_id,'publish',1,'{"visibility":"public"}');
 ASSERT NOT app_core.can_discover_character(card_id),'pending leaked to lobby';
 expected:=(r->>'submitted_revision')::integer;
 BEGIN
  PERFORM app_core.review_creator_character(admin_id,card_id,expected,'approve',NULL,'production');
  RAISE EXCEPTION 'environment authorization leaked';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 r:=app_core.review_creator_character(admin_id,card_id,expected,'approve',NULL,'test');
 ASSERT app_core.can_discover_character(card_id);
 PERFORM app_core.grant_creator_character_access(viewer_id,card_id);
 PERFORM miniapp_features.set_character_favorite(viewer_id,card_id,true);
 ASSERT app_core.read_character_runtime(card_id,viewer_id)->>'character_persona_and_style'='creator fixture persona',
   'creator runtime lost the direct persona field';
 ASSERT app_core.read_character_runtime(card_id,viewer_id,true)=jsonb_build_object('name','角色A','first_mes','开场A'),
   'creator opening-only projection changed';
 INSERT INTO experience.chat_sessions(id,user_id,character_id) VALUES(s_empty,viewer_id,card_id),(s_a,viewer_id,card_id),(s_owner,owner_id,card_id),(s_rollback,viewer_id,card_id);
 ASSERT (SELECT character_version_id IS NULL FROM experience.chat_sessions WHERE id=s_empty),'empty session froze prematurely';
 turn:=experience.start_chat_history_turn_with_current_postprocess(s_a,'第一句话','fixture');
 UPDATE experience.chat_history SET status='success',assistant_reply='回复A' WHERE id=(turn->>'history_id')::uuid;
 SELECT character_version_id INTO frozen_a FROM experience.chat_sessions WHERE id=s_a;
 ASSERT frozen_a IS NOT NULL;
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,s_a)->>'system_prompt'='prompt A';
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,s_a)->>'character_persona_and_style'='creator fixture persona',
   'first-turn version binding lost persona';
 ASSERT NOT (app_core.read_session_character_runtime(card_id,viewer_id,s_a) ? 'raw_card'),
   'unrelated imported JSON leaked into the frozen runtime';
 -- Transaction failure rolls back the version binding with the turn insert.
 BEGIN
  PERFORM experience.start_chat_history_turn_with_current_postprocess(s_rollback,'will rollback','fixture');
  RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='P0999';
 EXCEPTION WHEN SQLSTATE 'P0999' THEN NULL; END;
 ASSERT (SELECT character_version_id IS NULL FROM experience.chat_sessions WHERE id=s_rollback);
 ASSERT NOT EXISTS(SELECT 1 FROM experience.chat_history WHERE session_id=s_rollback);
 -- Owner trial freezes its draft, too.
 turn:=experience.start_chat_history_turn_with_current_postprocess(s_owner,'试聊','fixture');
 UPDATE experience.chat_history SET status='success',assistant_reply='作者试聊A' WHERE id=(turn->>'history_id')::uuid;
 SELECT character_version_id INTO owner_frozen FROM experience.chat_sessions WHERE id=s_owner;
 d:=d||'{"name":"角色B","description":"简介B","opening":"开场B","background":"背景B"}'::jsonb;
 runtime:=runtime||'{"name":"角色B","description":"简介B","first_mes":"开场B","system_prompt":"prompt B"}'::jsonb;
 payload:=jsonb_build_object('draft',d,'runtime',runtime,'cover_asset_id',cover_id);
 expected:=(r->>'revision')::integer;
 r:=app_core.mutate_creator_character(owner_id,card_id,'save',expected,payload);
 ASSERT app_core.mutate_creator_character(owner_id,card_id,'save',expected,payload)=r,'retry not idempotent';
 ASSERT app_core.mutate_creator_character(owner_id,card_id,'save',expected,payload||jsonb_build_object('runtime',runtime||jsonb_build_object('system_prompt','server asset changed')))=r,'server preset update changed a retry';
 ASSERT (SELECT draft_runtime->>'system_prompt' FROM app_core.character_creations WHERE character_id=card_id)='prompt B','retry rewrote saved runtime';
 BEGIN
  PERFORM app_core.mutate_creator_character(owner_id,card_id,'save',expected,payload||'{"cover_asset_id":null}'::jsonb);
  RAISE EXCEPTION 'stale save accepted';
 EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL; END;
 r:=app_core.mutate_creator_character(owner_id,card_id,'publish',(r->>'revision')::integer,'{"visibility":"public"}');
 expected:=(r->>'submitted_revision')::integer;
 ASSERT app_core.can_discover_character(card_id),'old approved runtime disappeared during review';
 ASSERT app_core.read_character_runtime(card_id,viewer_id)->>'system_prompt'='prompt A','pending draft leaked';
 ASSERT app_core.read_character_runtime(card_id,owner_id)->>'system_prompt'='prompt B';
 ASSERT app_core.read_session_character_runtime(card_id,owner_id,s_owner)->>'system_prompt'='prompt A','owner existing trial changed';
 r:=app_core.review_creator_character(admin_id,card_id,expected,'approve',NULL,'test');
 ASSERT app_core.read_character_runtime(card_id,viewer_id)->>'system_prompt'='prompt B';
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,s_a)->>'system_prompt'='prompt A','existing chat was updated';
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,s_empty,true)->>'first_mes'='开场B','empty chat opening failed to update';
 turn:=experience.start_chat_history_turn_with_current_postprocess(s_empty,'终于开聊','fixture');
 UPDATE experience.chat_history SET status='success',assistant_reply='回复B' WHERE id=(turn->>'history_id')::uuid;
 SELECT character_version_id INTO frozen_b FROM experience.chat_sessions WHERE id=s_empty;
 ASSERT frozen_b IS NOT NULL AND frozen_b<>frozen_a;
 ASSERT app_core.read_session_character_version(card_id,viewer_id,s_empty,true)->>'name'='角色B';
 turn:=experience.start_chat_history_regeneration_with_current_postprocess(s_a,NULL,'fixture');
 UPDATE experience.chat_history SET status='success',assistant_reply='重生成A' WHERE id=(turn->>'history_id')::uuid;
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,s_a)->>'system_prompt'='prompt A','regen changed card version';
 branch:=experience.fork_chat_session(viewer_id,s_a,(turn->>'history_id')::uuid,gen_random_uuid(),50);
 ASSERT (branch->>'character_version_id')::uuid=frozen_a,'branch failed to inherit version';
 turn:=experience.start_chat_history_turn_with_current_postprocess((branch->>'id')::uuid,'分支继续','fixture');
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,(branch->>'id')::uuid)->>'system_prompt'='prompt A';
 BEGIN
  PERFORM app_core.read_session_character_version(card_id,outsider_id,s_a,true);
  RAISE EXCEPTION 'session snapshot leaked';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 -- Hide from lobby without removing ever-used/favorited eligibility.
 r:=app_core.mutate_creator_character(owner_id,card_id,'visibility',(r->>'revision')::integer,'{"visibility":"private"}');
 PERFORM miniapp_features.set_character_favorite(viewer_id,card_id,false);
 UPDATE experience.chat_sessions SET deleted_at=now() WHERE id=s_empty;
 ASSERT NOT app_core.can_discover_character(card_id);
 ASSERT app_core.can_use_character(viewer_id,card_id) AND NOT app_core.can_use_character(outsider_id,card_id);
 ASSERT (SELECT count(*) FROM miniapp_features.get_character_socials(ARRAY[card_id],outsider_id))=0;
 ASSERT (SELECT count(*) FROM miniapp_features.get_character_socials(ARRAY[card_id],viewer_id))=1;
 ASSERT app_core.read_session_character_runtime(card_id,viewer_id,s_a)->>'system_prompt'='prompt A';
 -- A new edit invalidates the pending review, while existing immutable versions remain readable.
 r:=app_core.mutate_creator_character(owner_id,card_id,'publish',(r->>'revision')::integer,'{"visibility":"public"}');
 expected:=(r->>'submitted_revision')::integer;
 ASSERT NOT app_core.can_discover_character(card_id),'reopening private card bypassed review';
 r:=app_core.mutate_creator_character(owner_id,card_id,'save',(r->>'revision')::integer,payload);
 BEGIN
  PERFORM app_core.review_creator_character(admin_id,card_id,expected,'approve',NULL,'test');
  RAISE EXCEPTION 'old approval released new draft';
 EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL; END;
 BEGIN
  UPDATE app_core.character_versions SET runtime='{}' WHERE id=frozen_a;
  RAISE EXCEPTION 'version mutable';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 ASSERT NOT has_table_privilege('anon','app_core.character_versions','SELECT');
 ASSERT NOT has_table_privilege('authenticated','app_core.character_creations','SELECT');
 ASSERT NOT has_function_privilege('authenticated','app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)','EXECUTE');
 -- Legacy official cards do not get snapshots and existing sessions continue after unlisting.
 INSERT INTO app_core.characters(id,name,first_mes,system_prompt,character_persona_and_style,raw_card,character_book,extensions,alternate_greetings)
 VALUES(official_id,'官方卡','官方开场','official A','official fixture persona',large_import,large_import,'{"fixture":true}','["备选开场"]');
 ASSERT app_core.read_character_runtime(official_id,viewer_id,true)=jsonb_build_object('name','官方卡','first_mes','官方开场'),
   'official card opening failed with imported JSON and dropped columns';
 ASSERT app_core.read_character_runtime(official_id,viewer_id)->>'character_persona_and_style'='official fixture persona',
   'official runtime lost persona';
 INSERT INTO experience.chat_sessions(id,user_id,character_id) VALUES(s_official,viewer_id,official_id);
 ASSERT app_core.read_session_character_runtime(official_id,viewer_id,s_official,true)=jsonb_build_object('name','官方卡','first_mes','官方开场'),
   'legacy unversioned session opening failed';
 turn:=experience.start_chat_history_turn_with_current_postprocess(s_official,'官方第一句','fixture');
 ASSERT (SELECT character_version_id IS NULL FROM experience.chat_sessions WHERE id=s_official);
 UPDATE app_core.characters SET enabled=false,system_prompt='official B' WHERE id=official_id;
 ASSERT app_core.read_session_character_runtime(official_id,viewer_id,s_official)->>'system_prompt'='official B';
 ASSERT app_core.read_session_character_runtime(official_id,viewer_id,s_official,true)->>'first_mes'='官方开场';
 UPDATE app_core.characters SET character_persona_and_style=NULL WHERE id=official_id;
 ASSERT app_core.read_character_runtime(official_id,viewer_id)->'character_persona_and_style'='null'::jsonb,
   'nullable persona changed its JSON contract';
END $test$;
SELECT 'creator permissions and immutable card versions passed' AS result;
