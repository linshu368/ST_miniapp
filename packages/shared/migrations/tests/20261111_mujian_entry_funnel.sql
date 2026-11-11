-- TEST only. All synthetic accounts and attribution facts roll back together.
-- The migration workflow never invokes this file against Production.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app_core.users WHERE tg_id BETWEEN '8999999999999901' AND '8999999999999907') THEN
    RAISE EXCEPTION 'TEST fixture identity collision; refusing to touch existing accounts';
  END IF;
END $$;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  t timestamptz := date_trunc('second', now()) - interval '1 hour';
  r jsonb;
  uid uuid;
BEGIN
  r := miniapp_traffic.record_app_entry('8999999999999901', 'mujian', 'mujian_dzmm', t);
  IF r->>'eligibility' <> 'new' OR (r->>'converted')::boolean THEN
    RAISE EXCEPTION 'new user / click-only qualification failed';
  END IF;
  SELECT id INTO STRICT uid FROM app_core.users WHERE tg_id = '8999999999999901';
  IF (SELECT miniapp_entered_at FROM app_core.users WHERE id = uid) IS NOT NULL THEN
    RAISE EXCEPTION 'Mujian prematurely marked Mijing entry';
  END IF;
  PERFORM miniapp_traffic.record_app_entry('8999999999999901', 'mujian', 'mujian_dzmm', t);
  IF (SELECT count(*) FROM miniapp_traffic.app_entry_facts WHERE user_id = uid) <> 1 THEN
    RAISE EXCEPTION 'entry retry was not deduplicated';
  END IF;
  r := miniapp_traffic.record_app_entry('8999999999999901', 'mijing', 'mujian_dzmm', t + interval '2 minutes');
  IF NOT (r->>'converted')::boolean THEN RAISE EXCEPTION 'same-channel conversion failed'; END IF;
  UPDATE app_core.users SET total_round = 4 WHERE id = uid;
  r := miniapp_traffic.record_app_entry('8999999999999901', 'mujian', 'mujian_dzmm', t);
  IF r->>'eligibility' <> 'new' THEN RAISE EXCEPTION 'qualification was not frozen'; END IF;

  PERFORM miniapp_traffic.record_app_entry('8999999999999902', 'mijing', 'mujian_dzmm', t + interval '2 minutes');
  r := miniapp_traffic.record_app_entry('8999999999999902', 'mujian', 'mujian_dzmm', t);
  IF r->>'eligibility' <> 'new' OR NOT (r->>'converted')::boolean THEN
    RAISE EXCEPTION 'reverse arrival reconciliation failed';
  END IF;

  INSERT INTO app_core.users(tg_id, miniapp_entered_at, source_id)
    VALUES ('8999999999999903', t - interval '1 day', 'mujian_test_original');
  r := miniapp_traffic.record_app_entry('8999999999999903', 'mujian', 'mujian_dzmm', t);
  IF r->>'eligibility' <> 'existing' OR
    (SELECT source_id FROM app_core.users WHERE tg_id = '8999999999999903') <> 'mujian_test_original' THEN
    RAISE EXCEPTION 'existing user / original source handling failed';
  END IF;

  INSERT INTO app_core.users(tg_id) VALUES ('8999999999999904');
  r := miniapp_traffic.record_app_entry('8999999999999904', 'mujian', 'mujian_dzmm', t);
  IF r->>'eligibility' <> 'unknown' THEN RAISE EXCEPTION 'unknown history counted as new'; END IF;

  INSERT INTO app_core.users(tg_id, bot_entered_at) VALUES ('8999999999999905', t - interval '1 day');
  r := miniapp_traffic.record_app_entry('8999999999999905', 'mujian', 'mujian_dzmm', t);
  IF r->>'eligibility' <> 'new' THEN RAISE EXCEPTION 'unused Bot account excluded'; END IF;

  r := miniapp_traffic.record_app_entry('8999999999999906', 'mujian', NULL, t);
  IF r->>'source_id' IS NOT NULL THEN RAISE EXCEPTION 'organic source defaulted to campaign'; END IF;
  r := miniapp_traffic.record_app_entry('8999999999999906', 'mijing', 'mujian_dzmm', t + interval '2 minutes');
  IF (r->>'converted')::boolean THEN RAISE EXCEPTION 'organic entry counted as campaign conversion'; END IF;

  r := miniapp_traffic.record_app_entry('8999999999999907', 'mijing', 'mujian_dzmm', t);
  IF (r->>'converted')::boolean THEN RAISE EXCEPTION 'direct Mijing entry converted'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF has_table_privilege('anon', 'miniapp_traffic.app_entry_facts', 'SELECT') OR
    has_function_privilege('authenticated', 'miniapp_traffic.record_app_entry(text,text,text,timestamptz)', 'EXECUTE') OR
    NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'miniapp_traffic.app_entry_facts'::regclass) THEN
    RAISE EXCEPTION 'entry facts exposure';
  END IF;
END $$;
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app_core.users WHERE tg_id BETWEEN '8999999999999901' AND '8999999999999907') THEN
    RAISE EXCEPTION 'TEST fixtures persisted';
  END IF;
END $$;
SELECT 'TEST funnel assertions passed; all fixtures rolled back' AS result;
