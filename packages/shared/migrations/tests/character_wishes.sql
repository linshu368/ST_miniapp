-- Reusable isolated synthetic fixture; never run against a platform database.
DO $$ BEGIN
 IF current_database() NOT LIKE 'creator_core_test_%' THEN RAISE EXCEPTION 'disposable creator test database required'; END IF;
END $$;
BEGIN;
CREATE FUNCTION pg_temp.reject_wish_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='character_wish_response' AND NEW.body LIKE '「回滚卡」%' THEN
   RAISE EXCEPTION 'synthetic notification failure' USING ERRCODE='P0999';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wish_fixture_failure BEFORE INSERT ON miniapp_features.notifications
 FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_wish_notification();
DO $test$
DECLARE
 author_id uuid:='77000000-0000-4000-8000-000000000001';
 supporter_id uuid:='77000000-0000-4000-8000-000000000002';
 creator_id uuid:='77000000-0000-4000-8000-000000000003';
 other_id uuid:='77000000-0000-4000-8000-000000000004';
 wish_id uuid:='77000000-0000-4000-8000-000000000011';
 rejected_id uuid:='77000000-0000-4000-8000-000000000012';
 card_id uuid:='77000000-0000-4000-8000-000000000021';
 other_card_id uuid:='77000000-0000-4000-8000-000000000022';
 r jsonb;
BEGIN
 INSERT INTO app_core.users(id) VALUES(author_id),(supporter_id),(creator_id),(other_id);
 INSERT INTO app_core.characters(id,name,description) VALUES(card_id,'愿望中的角色','公开简介'),(other_card_id,'别人的卡','');
 INSERT INTO app_core.character_creations(character_id,owner_user_id,draft,draft_runtime,state,visibility,approved_revision,published_revision,review_status)
 VALUES(card_id,creator_id,'{}','{}','ready','public',1,1,'approved'),(other_card_id,other_id,'{}','{}','ready','public',1,1,'approved');
 r:=miniapp_features.mutate_character_wish(author_id,wish_id,'create','{"body":"有自己生活的旅店老板","visibility":"public"}');
 ASSERT r->'wish'->>'wanted_count'='1' AND r->'wish'->>'supported'='false';
 ASSERT NOT (r->'wish' ? 'owner_user_id') AND NOT (r->'wish' ? 'author');
 ASSERT miniapp_features.mutate_character_wish(author_id,wish_id,'create','{"body":"有自己生活的旅店老板","visibility":"public"}')=r,'create replay changed result';
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(other_id,wish_id,'create','{"body":"有自己生活的旅店老板","visibility":"public"}');
   RAISE EXCEPTION 'foreign create replay accepted';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(author_id,wish_id,'create','{"body":"different","visibility":"public"}');
   RAISE EXCEPTION 'create UUID reused with different body';
 EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL; END;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(author_id,rejected_id,'create','{"body":"私密心愿应被拒绝","visibility":"private"}');
   RAISE EXCEPTION 'private wish RPC accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN
   INSERT INTO miniapp_features.character_wishes(id,owner_user_id,body,visibility) VALUES(rejected_id,author_id,'private direct write','private');
   RAISE EXCEPTION 'private wish table write accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 ASSERT NOT EXISTS(SELECT 1 FROM miniapp_features.character_wishes WHERE id=rejected_id);
 r:=miniapp_features.list_character_wishes(other_id,'public','newest',1,12);
 ASSERT r->>'total'='1' AND r->'items'->0->>'id'=wish_id::text;
 ASSERT NOT (r->'items'->0 ? 'owner_user_id');
 r:=miniapp_features.list_character_wishes(author_id,'mine','newest',1,12);
 ASSERT r->>'total'='1' AND NOT (r->'items'->0 ? 'owner_user_id') AND NOT (r->'items'->0 ? 'author');
 ASSERT miniapp_features.list_character_wishes(other_id,'mine','newest',1,12)->>'total'='0';
 ASSERT miniapp_features.read_character_wish(author_id,wish_id)->'wish'->>'visibility'='public';
 BEGIN
   PERFORM miniapp_features.read_character_wish(other_id,rejected_id); RAISE EXCEPTION 'rejected wish readable';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(other_id,rejected_id,'support','{"supported":true}'); RAISE EXCEPTION 'missing wish support accepted';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(author_id,wish_id,'support','{"supported":true}'); RAISE EXCEPTION 'author double counted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 r:=miniapp_features.mutate_character_wish(supporter_id,wish_id,'support','{"supported":true}');
 ASSERT r->'wish'->>'wanted_count'='2' AND r->'wish'->>'supported'='true';
 ASSERT miniapp_features.mutate_character_wish(supporter_id,wish_id,'support','{"supported":true}')=r,'support retry double counted';
 r:=miniapp_features.mutate_character_wish(supporter_id,wish_id,'support','{"supported":false}');
 ASSERT r->'wish'->>'wanted_count'='1';
 PERFORM miniapp_features.mutate_character_wish(supporter_id,wish_id,'support','{"supported":true}');
 PERFORM miniapp_features.mutate_character_wish(creator_id,wish_id,'support','{"supported":true}');
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(creator_id,wish_id,'respond',jsonb_build_object('character_id',other_card_id));
   RAISE EXCEPTION 'foreign character attached';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(creator_id,rejected_id,'respond',jsonb_build_object('character_id',card_id));
   RAISE EXCEPTION 'missing wish response attached';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 UPDATE app_core.characters SET enabled=false WHERE id=card_id;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(creator_id,wish_id,'respond',jsonb_build_object('character_id',card_id));
   RAISE EXCEPTION 'disabled card attached';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 UPDATE app_core.characters SET enabled=true WHERE id=card_id;
 UPDATE app_core.character_creations SET approved_revision=NULL WHERE character_id=card_id;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(creator_id,wish_id,'respond',jsonb_build_object('character_id',card_id));
   RAISE EXCEPTION 'unapproved card attached';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 UPDATE app_core.character_creations SET approved_revision=1 WHERE character_id=card_id;
 r:=miniapp_features.mutate_character_wish(creator_id,wish_id,'respond',jsonb_build_object('character_id',card_id));
 ASSERT r='{"linked":true}'::jsonb;
 ASSERT (SELECT count(*) FROM miniapp_features.character_wish_responses)=1;
 ASSERT (SELECT count(*) FROM miniapp_features.notifications WHERE kind='character_wish_response')=2,'recipient union or self exclusion incorrect';
 ASSERT NOT EXISTS(SELECT 1 FROM miniapp_features.notifications WHERE kind='character_wish_response' AND
   (user_id NOT IN (author_id,supporter_id) OR action_path<>'/wishes/'||wish_id::text OR NOT is_published OR scope<>'personal'));
 -- Retry must not notify people who supported only after the original response, either.
 PERFORM miniapp_features.mutate_character_wish(other_id,wish_id,'support','{"supported":true}');
 PERFORM miniapp_features.mutate_character_wish(creator_id,wish_id,'respond',jsonb_build_object('character_id',card_id));
 ASSERT (SELECT count(*) FROM miniapp_features.notifications WHERE kind='character_wish_response')=2;
 -- A notification insert failure must roll back the response, allowing a later retry.
 UPDATE app_core.characters SET name='回滚卡' WHERE id=other_card_id;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(other_id,wish_id,'respond',jsonb_build_object('character_id',other_card_id));
   RAISE EXCEPTION 'fixture did not fail the notification insert';
 EXCEPTION WHEN SQLSTATE 'P0999' THEN NULL; END;
 ASSERT NOT EXISTS(SELECT 1 FROM miniapp_features.character_wish_responses WHERE character_id=other_card_id),
   'failed notification left behind a committed response';
 ASSERT (SELECT count(*) FROM miniapp_features.notifications WHERE kind='character_wish_response')=2;
 r:=miniapp_features.read_character_wish(author_id,wish_id);
 ASSERT r->'wish'->>'response_count'='1' AND r->'cards'->0->>'name'='愿望中的角色';
 -- Changed visibility removes it from the wish response presentation, but preserves association.
 UPDATE app_core.character_creations SET visibility='private' WHERE character_id=card_id;
 r:=miniapp_features.read_character_wish(author_id,wish_id);
 ASSERT r->'wish'->>'response_count'='0' AND r->'cards'='[]'::jsonb;
 UPDATE app_core.character_creations SET visibility='public' WHERE character_id=card_id;
 -- Reuse the existing notification shape: VIP still accepted; malformed wish metadata rejected.
 INSERT INTO miniapp_features.notifications(scope,category,title,body,user_id,kind,business_key,action_path,metadata)
 VALUES('official','system','VIP','VIP fixture',author_id,'vip_expiry','wish-test-vip','/vip',
   '{"reminder_window":"expires_today","observed_valid_until":"2026-12-01T00:00:00Z"}');
 BEGIN
   INSERT INTO miniapp_features.notifications(scope,category,title,body,user_id,kind,business_key,action_path,metadata)
   VALUES('personal','interaction','bad','bad',author_id,'character_wish_response','bad','/vip',jsonb_build_object('wish_id',wish_id,'character_id',card_id));
   RAISE EXCEPTION 'invalid action accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   PERFORM miniapp_features.mutate_character_wish(other_id,wish_id,'withdraw','{}'); RAISE EXCEPTION 'foreign withdrawal accepted';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 ASSERT miniapp_features.mutate_character_wish(author_id,wish_id,'withdraw','{}')='{"withdrawn":true}'::jsonb;
 ASSERT miniapp_features.mutate_character_wish(author_id,wish_id,'withdraw','{}')='{"withdrawn":true}'::jsonb;
 ASSERT miniapp_features.list_character_wishes(other_id,'public','newest',1,12)->>'total'='0';
 BEGIN
   PERFORM miniapp_features.read_character_wish(author_id,wish_id); RAISE EXCEPTION 'withdrawn wish readable';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
 ASSERT NOT has_table_privilege('authenticated','miniapp_features.character_wishes','SELECT');
 ASSERT NOT has_table_privilege('anon','miniapp_features.character_wish_supports','INSERT');
 ASSERT NOT has_table_privilege('service_role','miniapp_features.character_wishes','UPDATE');
 ASSERT NOT has_function_privilege('authenticated','miniapp_features.mutate_character_wish(uuid,uuid,text,jsonb)','EXECUTE');
 ASSERT NOT has_function_privilege('anon','miniapp_features.read_character_wish(uuid,uuid)','EXECUTE');
 ASSERT NOT has_function_privilege('service_role','miniapp_features.character_wish_dto(miniapp_features.character_wishes,uuid)','EXECUTE');
 ASSERT has_function_privilege('service_role','miniapp_features.mutate_character_wish(uuid,uuid,text,jsonb)','EXECUTE');
 ASSERT (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('miniapp_features.character_wishes'::regclass,
   'miniapp_features.character_wish_supports'::regclass,'miniapp_features.character_wish_responses'::regclass));
END $test$;
SET LOCAL ROLE service_role;
SELECT miniapp_features.mutate_character_wish('10000000-0000-4000-8000-000000000001',
 '77000000-0000-4000-8000-000000000099','create','{"body":"backend role fixture","visibility":"public"}') IS NOT NULL;
RESET ROLE;
ROLLBACK;
