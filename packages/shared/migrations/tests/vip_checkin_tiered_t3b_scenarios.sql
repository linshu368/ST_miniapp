-- Local T3B check-in tier scenarios. Run only after 20261014_checkin_tiered_rewards.sql
-- on a throwaway database. Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS vip_t3b_test;

CREATE OR REPLACE FUNCTION vip_t3b_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T3B check-in tier scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t3b_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  u_plain UUID := '00000000-0000-4000-8000-000000000061';
  u_veteran UUID := '00000000-0000-4000-8000-000000000062';
  u_vip UUID := '00000000-0000-4000-8000-000000000063';
  u_expired UUID := '00000000-0000-4000-8000-000000000064';
  v_json JSONB;
  v_bonus NUMERIC;
  v_main NUMERIC;
BEGIN
  INSERT INTO app_core.users (id)
  VALUES (u_plain), (u_veteran), (u_vip), (u_expired)
  ON CONFLICT (id) DO NOTHING;

  UPDATE app_core.users
  SET created_at = now() - interval '15 days'
  WHERE id = u_veteran;

  INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits)
  VALUES
    (u_plain, 10, 0),
    (u_veteran, 10, 0),
    (u_vip, 10, 0),
    (u_expired, 10, 0)
  ON CONFLICT (user_id) DO UPDATE
  SET main_credits = EXCLUDED.main_credits, bonus_credits = EXCLUDED.bonus_credits;

  PERFORM vip_t3b_test.assert(
    (SELECT value FROM app_core.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits') = '0'::jsonb,
    'legacy base is 0'
  );
  PERFORM vip_t3b_test.assert(
    (SELECT value FROM app_core.runtime_config WHERE key = 'vip_checkin_bonus_config') = '150'::jsonb,
    'vip absolute is 150'
  );

  PERFORM admin.validate_managed_config_value('vip_checkin_bonus_config', '150'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('miniapp_checkin_new_user_credits', '60'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('miniapp_checkin_veteran_credits', '15'::jsonb, NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'vip_checkin_bonus_config',
      '{"mode":"same_as_base"}'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'legacy vip object should be rejected';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  v_json := miniapp_features.claim_daily_checkin(u_plain);
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'reward_credits')::int = 60, 'plain new-user total');
  PERFORM vip_t3b_test.assert(v_json->'checkin'->>'reward_tier' = 'new_user', 'plain tier');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_plain;
  PERFORM vip_t3b_test.assert(v_main = 10 AND v_bonus = 60, 'plain wallet');

  v_json := miniapp_features.claim_daily_checkin(u_veteran);
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'reward_credits')::int = 15, 'veteran total');
  PERFORM vip_t3b_test.assert(v_json->'checkin'->>'reward_tier' = 'veteran', 'veteran tier');

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_vip, now() - interval '1 day', now() + interval '10 days', 'month')
  ON CONFLICT (user_id) DO UPDATE
  SET valid_until = EXCLUDED.valid_until, last_plan_id = EXCLUDED.last_plan_id;
  v_json := miniapp_features.claim_daily_checkin(u_vip);
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'base_reward_credits')::int = 0, 'vip base');
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 150, 'vip absolute');
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'reward_credits')::int = 150, 'vip total');
  SELECT bonus_credits INTO v_bonus FROM billing.user_wallets WHERE user_id = u_vip;
  PERFORM vip_t3b_test.assert(v_bonus = 150, 'vip wallet');

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_expired, now() - interval '10 days', now() - interval '1 second', 'week')
  ON CONFLICT (user_id) DO UPDATE
  SET valid_until = EXCLUDED.valid_until, last_plan_id = EXCLUDED.last_plan_id;
  v_json := miniapp_features.claim_daily_checkin(u_expired);
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'reward_credits')::int = 60, 'expired falls to new-user');
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 0, 'expired no vip');

  RETURN 'vip t3b check-in tier scenarios passed';
END;
$$;

SELECT vip_t3b_test.run();

-- Called by the same harness after 20261030_checkin_calendar_day.sql.
CREATE OR REPLACE FUNCTION vip_t3b_test.run_calendar()
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  u_yesterday uuid := '00000000-0000-4000-8000-000000000065';
  u_today uuid := '00000000-0000-4000-8000-000000000066';
  u_vip uuid := '00000000-0000-4000-8000-000000000067';
  v_start timestamptz := date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_json jsonb;
  v_rejected boolean := false;
BEGIN
  INSERT INTO app_core.users(id) VALUES (u_yesterday), (u_today), (u_vip);
  INSERT INTO miniapp_features.daily_checkins(user_id, reward_credits, claimed_at)
  VALUES (u_yesterday, 60, v_start - interval '1 second'),
         (u_today, 60, v_start),
         (u_vip, 150, v_start - interval '1 second');
  INSERT INTO billing.vip_memberships(user_id, valid_from, valid_until, last_plan_id)
  VALUES (u_vip, now() - interval '1 day', now() + interval '10 days', 'month');

  -- Yesterday's 23:59:59 can claim again today, even within the old 24h cooldown.
  v_json := miniapp_features.claim_daily_checkin(u_yesterday);
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'reward_credits')::int = 60, 'calendar amount preserved');
  PERFORM vip_t3b_test.assert(
    (v_json->'checkin'->>'next_claim_at')::timestamptz = v_start + interval '1 day',
    'next claim is Beijing midnight'
  );
  BEGIN
    PERFORM miniapp_features.claim_daily_checkin(u_yesterday);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_rejected := true;
  END;
  PERFORM vip_t3b_test.assert(v_rejected, 'same-day second claim rejected');
  PERFORM vip_t3b_test.assert(
    (SELECT count(*) = 1 FROM billing.wallet_ledger WHERE user_id = u_yesterday AND entry_type = 'checkin_bonus'),
    'second claim does not grant another ledger entry'
  );

  v_rejected := false;
  BEGIN
    PERFORM miniapp_features.claim_daily_checkin(u_today);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_rejected := true;
  END;
  PERFORM vip_t3b_test.assert(v_rejected, 'exact midnight counts as already claimed today');
  PERFORM vip_t3b_test.assert(
    NOT EXISTS (SELECT 1 FROM billing.wallet_ledger WHERE user_id = u_today),
    'rejected midnight claim leaves wallet ledger untouched'
  );

  v_json := miniapp_features.claim_daily_checkin(u_vip);
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'reward_credits')::int = 150, 'VIP still uses configured absolute amount');
  PERFORM vip_t3b_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 150, 'VIP reward split preserved');
  RETURN 'calendar-day check-in scenarios passed';
END;
$$;
