SET ROLE service_role;
DO $$
DECLARE t timestamptz := date_trunc('second',now()) - interval '1 hour'; r jsonb; uid uuid;
BEGIN
 r := miniapp_traffic.record_app_entry('10001','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'new' OR (r->>'converted')::boolean THEN RAISE EXCEPTION 'new qualification'; END IF;
 SELECT id INTO uid FROM app_core.users WHERE tg_id='10001';
 IF (SELECT miniapp_entered_at FROM app_core.users WHERE id=uid) IS NOT NULL THEN RAISE EXCEPTION 'premature Mijing marker'; END IF;
 PERFORM miniapp_traffic.record_app_entry('10001','mujian','mujian_dzmm',t);
 IF (SELECT count(*) FROM miniapp_traffic.app_entry_facts WHERE user_id=uid) <> 1 THEN RAISE EXCEPTION 'dedup'; END IF;
 r := miniapp_traffic.record_app_entry('10001','mijing','mujian_dzmm',t+interval '2 minutes');
 IF NOT (r->>'converted')::boolean THEN RAISE EXCEPTION 'conversion'; END IF;
 UPDATE app_core.users SET total_round=4 WHERE id=uid;
 r := miniapp_traffic.record_app_entry('10001','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'new' THEN RAISE EXCEPTION 'frozen qualification'; END IF;
 IF (SELECT clicks FROM miniapp_traffic.traffic_clicks WHERE source_id='mujian_dzmm') <> 1 THEN RAISE EXCEPTION 'source counter dedup'; END IF;

 -- Reverse arrival: signed Mujian launch preceded Mijing, even when Mijing reached backend first.
 PERFORM miniapp_traffic.record_app_entry('10002','mijing','mujian_dzmm',t+interval '2 minutes');
 r := miniapp_traffic.record_app_entry('10002','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'new' OR NOT (r->>'converted')::boolean THEN RAISE EXCEPTION 'reverse arrival'; END IF;
 -- Earlier Mijing history must exclude a later Mujian entry even if the server marker is delayed.
 PERFORM miniapp_traffic.record_app_entry('10014','mijing','mujian_dzmm',t);
 r := miniapp_traffic.record_app_entry('10014','mujian','mujian_dzmm',t+interval '2 minutes');
 IF r->>'eligibility' <> 'existing' THEN RAISE EXCEPTION 'direct before Mujian'; END IF;
 -- Reverse arrival of PRE-Mujian history corrects evidence; subsequent Mijing still preserves eligibility.
 PERFORM miniapp_traffic.record_app_entry('10015','mujian','mujian_dzmm',t+interval '2 minutes');
 PERFORM miniapp_traffic.record_app_entry('10015','mijing','mujian_dzmm',t);
 IF (SELECT eligibility FROM miniapp_traffic.app_entry_facts WHERE user_id=(SELECT id FROM app_core.users WHERE tg_id='10015') AND surface='mujian') <> 'existing' THEN RAISE EXCEPTION 'late historical entry'; END IF;
 -- Direct entry, natural traffic, and wrong-channel first Mijing entry cannot convert.
 PERFORM miniapp_traffic.record_app_entry('10003','mijing','mujian_dzmm',t);
 IF EXISTS(SELECT 1 FROM miniapp_traffic.app_entry_facts WHERE user_id=(SELECT id FROM app_core.users WHERE tg_id='10003') AND converted_at IS NOT NULL) THEN RAISE EXCEPTION 'direct conversion'; END IF;
 PERFORM miniapp_traffic.record_app_entry('10004','mujian',NULL,t);
 PERFORM miniapp_traffic.record_app_entry('10004','mijing','mujian_dzmm',t+interval '2 minutes');
 PERFORM miniapp_traffic.record_app_entry('10005','mujian','mujian_dzmm',t);
 PERFORM miniapp_traffic.record_app_entry('10005','mijing','legacy_channel',t+interval '1 minute');
 r := miniapp_traffic.record_app_entry('10005','mijing','mujian_dzmm',t+interval '2 minutes');
 IF (r->>'converted')::boolean THEN RAISE EXCEPTION 'wrong first channel'; END IF;

 INSERT INTO app_core.users(tg_id,miniapp_entered_at,source_id) VALUES('10006',t-interval '1 day','legacy_channel');
 r := miniapp_traffic.record_app_entry('10006','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'existing' THEN RAISE EXCEPTION 'existing entry'; END IF;
 IF (SELECT source_id FROM app_core.users WHERE tg_id='10006') <> 'legacy_channel' THEN RAISE EXCEPTION 'original source overwritten'; END IF;
 INSERT INTO app_core.users(tg_id) VALUES('10007');
 r := miniapp_traffic.record_app_entry('10007','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'unknown' THEN RAISE EXCEPTION 'unknown history'; END IF;
 INSERT INTO app_core.users(tg_id,bot_entered_at) VALUES('10008',t-interval '1 day');
 r := miniapp_traffic.record_app_entry('10008','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'new' THEN RAISE EXCEPTION 'bot-only account'; END IF;
 INSERT INTO app_core.users(tg_id) VALUES('10009') RETURNING id INTO uid;
 INSERT INTO experience.chat_history VALUES(uid,t-interval '1 day');
 r := miniapp_traffic.record_app_entry('10009','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'existing' THEN RAISE EXCEPTION 'real historical usage'; END IF;
 -- A normal Mijing API can create the account before growth; same-second snapshot is unknown
 -- at Mijing, but its marker is unambiguously AFTER the delayed Mujian launch.
 INSERT INTO app_core.users(tg_id,miniapp_entered_at) VALUES('10012',t+interval '120.2 seconds');
 PERFORM miniapp_traffic.record_app_entry('10012','mijing','mujian_dzmm',t+interval '120 seconds');
 r := miniapp_traffic.record_app_entry('10012','mujian','mujian_dzmm',t);
 IF r->>'eligibility' <> 'new' OR NOT (r->>'converted')::boolean THEN RAISE EXCEPTION 'reverse arrival after normal API'; END IF;
 -- A late earlier channel must invalidate an apparent conversion, without changing Mujian qualification.
 PERFORM miniapp_traffic.record_app_entry('10013','mujian','mujian_dzmm',t);
 PERFORM miniapp_traffic.record_app_entry('10013','mijing','mujian_dzmm',t+interval '120 seconds');
 PERFORM miniapp_traffic.record_app_entry('10013','mijing','legacy_channel',t+interval '60 seconds');
 IF EXISTS(SELECT 1 FROM miniapp_traffic.app_entry_facts WHERE user_id=(SELECT id FROM app_core.users WHERE tg_id='10013') AND converted_at IS NOT NULL) THEN RAISE EXCEPTION 'earlier channel'; END IF;
 PERFORM miniapp_traffic.record_app_entry('10010','mijing','legacy_channel',t);
 IF (SELECT source_id FROM app_core.users WHERE tg_id='10010') <> 'legacy_channel' THEN RAISE EXCEPTION 'legacy source'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF has_table_privilege('anon','miniapp_traffic.app_entry_facts','SELECT') OR has_table_privilege('authenticated','miniapp_traffic.app_entry_facts','INSERT') OR has_function_privilege('anon','miniapp_traffic.record_app_entry(text,text,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'public grant'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='miniapp_traffic.app_entry_facts'::regclass) THEN RAISE EXCEPTION 'missing RLS'; END IF;
END $$;
SELECT 'mujian local PostgreSQL assertions passed' AS result;

-- Production retains an optional legacy marker; absence in TEST must remain supported.
ALTER TABLE app_core.users ADD COLUMN st_initialized_at timestamptz;
INSERT INTO app_core.users(tg_id,bot_entered_at,st_initialized_at) VALUES('10016',now()-interval '2 days',now()-interval '1 day');
DO $$ DECLARE r jsonb; BEGIN
 r:=miniapp_traffic.record_app_entry('10016','mujian','mujian_dzmm',date_trunc('second',now()));
 IF r->>'eligibility'<>'existing' THEN RAISE EXCEPTION 'legacy initialization ignored'; END IF;
END $$;
ALTER TABLE app_core.users DROP COLUMN st_initialized_at;
