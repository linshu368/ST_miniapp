-- Local T3 check-in scenarios. Run only after 20260922_daily_checkin_vip_bonus.sql
-- on a throwaway database. Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS vip_t3_test;

CREATE OR REPLACE FUNCTION vip_t3_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T3 check-in scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t3_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  u_plain UUID := '00000000-0000-4000-8000-000000000041';
  u_vip UUID := '00000000-0000-4000-8000-000000000042';
  u_expired UUID := '00000000-0000-4000-8000-000000000043';
  u_exact UUID := '00000000-0000-4000-8000-000000000044';
  u_edge UUID := '00000000-0000-4000-8000-000000000045';
  u_repeat UUID := '00000000-0000-4000-8000-000000000046';
  v_json JSONB;
  v_bonus NUMERIC;
  v_main NUMERIC;
  v_count INTEGER;
  v_raised BOOLEAN;
BEGIN
  INSERT INTO app_core.users (id)
  VALUES (u_plain), (u_vip), (u_expired), (u_exact), (u_edge), (u_repeat)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits)
  VALUES
    (u_plain, 10, 0),
    (u_vip, 10, 0),
    (u_expired, 10, 0),
    (u_exact, 10, 0),
    (u_edge, 10, 0),
    (u_repeat, 10, 0)
  ON CONFLICT (user_id) DO UPDATE
  SET main_credits = EXCLUDED.main_credits, bonus_credits = EXCLUDED.bonus_credits;

  PERFORM vip_t3_test.assert(
    (SELECT value FROM app_core.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits') = '60'::jsonb,
    'config base is 60'
  );

  v_json := miniapp_features.claim_daily_checkin(u_plain);
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'base_reward_credits')::int = 60, 'plain base');
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 0, 'plain vip extra');
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'reward_credits')::int = 60, 'plain total');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_plain;
  PERFORM vip_t3_test.assert(v_main = 10 AND v_bonus = 60 AND v_main + v_bonus = 70, 'plain wallet');

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_vip, now() - interval '1 day', now() + interval '10 days', 'month');
  v_json := miniapp_features.claim_daily_checkin(u_vip);
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'base_reward_credits')::int = 60, 'vip base');
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 60, 'vip extra');
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'reward_credits')::int = 120, 'vip total');
  SELECT count(*) INTO v_count
  FROM billing.wallet_ledger
  WHERE user_id = u_vip AND entry_type = 'checkin_bonus';
  PERFORM vip_t3_test.assert(v_count = 1, 'vip one ledger');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_vip;
  PERFORM vip_t3_test.assert(v_main = 10 AND v_bonus = 120, 'vip bonus wallet');

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_expired, now() - interval '10 days', now() - interval '1 second', 'week');
  v_json := miniapp_features.claim_daily_checkin(u_expired);
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'reward_credits')::int = 60, 'expired total');
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 0, 'expired extra');

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_exact, now() - interval '1 day', now(), 'week');
  v_json := miniapp_features.claim_daily_checkin(u_exact);
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'reward_credits')::int = 60, 'exact expiry is not active');

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_edge, now() - interval '1 day', now() + interval '1 millisecond', 'week');
  v_json := miniapp_features.claim_daily_checkin(u_edge);
  PERFORM vip_t3_test.assert((v_json->'checkin'->>'reward_credits')::int = 120, 'one millisecond still active');

  v_json := miniapp_features.claim_daily_checkin(u_repeat);
  v_raised := false;
  BEGIN
    PERFORM miniapp_features.claim_daily_checkin(u_repeat);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := true;
  END;
  PERFORM vip_t3_test.assert(v_raised, 'repeat check-in raises');
  SELECT count(*) INTO v_count FROM miniapp_features.daily_checkins WHERE user_id = u_repeat;
  PERFORM vip_t3_test.assert(v_count = 1, 'repeat does not insert a second check-in');
  SELECT bonus_credits INTO v_bonus FROM billing.user_wallets WHERE user_id = u_repeat;
  PERFORM vip_t3_test.assert(v_bonus = 60, 'repeat does not pay twice');

  PERFORM vip_t3_test.assert(
    has_function_privilege('anon', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE'),
    'historical anon execute remains'
  );

  RETURN 'vip t3 check-in scenarios passed';
END;
$$;

SELECT vip_t3_test.run();
