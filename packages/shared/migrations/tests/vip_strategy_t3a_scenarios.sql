-- Local T3A VIP strategy scenarios. Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS vip_t3a_test;

CREATE OR REPLACE FUNCTION vip_t3a_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T3A scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t3a_test.expect_raise(p_sql TEXT, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_raised BOOLEAN := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T3A scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t3a_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  u_limit UUID := '00000000-0000-4000-8000-0000000000d1';
  u_zero UUID := '00000000-0000-4000-8000-0000000000d2';
  u_raise UUID := '00000000-0000-4000-8000-0000000000d3';
  u_lower UUID := '00000000-0000-4000-8000-0000000000d4';
  u_checkin_vip UUID := '00000000-0000-4000-8000-0000000000d5';
  u_checkin_fixed UUID := '00000000-0000-4000-8000-0000000000d6';
  u_checkin_bad UUID := '00000000-0000-4000-8000-0000000000d7';
  u_checkin_plain UUID := '00000000-0000-4000-8000-0000000000d8';
  u_order_old UUID := '00000000-0000-4000-8000-0000000000d9';
  u_order_new UUID := '00000000-0000-4000-8000-0000000000da';
  u_order_month UUID := '00000000-0000-4000-8000-0000000000db';
  v_json JSONB;
  v_bonus NUMERIC;
  v_count INTEGER;
  v_reward INTEGER;
  v_days NUMERIC;
  v_limits JSONB;
  i INTEGER;
BEGIN
  INSERT INTO app_core.users (id)
  VALUES
    (u_limit), (u_zero), (u_raise), (u_lower),
    (u_checkin_vip), (u_checkin_fixed), (u_checkin_bad), (u_checkin_plain),
    (u_order_old), (u_order_new), (u_order_month);
  INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits)
  SELECT id, 0, 0 FROM app_core.users
  WHERE id IN (
    u_limit, u_zero, u_raise, u_lower,
    u_checkin_vip, u_checkin_fixed, u_checkin_bad, u_checkin_plain,
    u_order_old, u_order_new, u_order_month
  );

  PERFORM vip_t3a_test.assert(
    (SELECT value FROM app_core.runtime_config WHERE key = 'vip_purchase_enabled') = 'false'::jsonb
    AND (SELECT value FROM app_core.runtime_config WHERE key = 'vip_reminders_enabled') = 'false'::jsonb,
    'switches stay false'
  );

  PERFORM vip_t3a_test.expect_raise(
    $$SELECT admin.validate_managed_config_value('vip_plans_config', '{"week":{"price_cents":0,"duration_days":7,"bonus_credits":0,"title":"周卡","description":null,"badge_text":null},"month":{"price_cents":2888,"duration_days":31,"bonus_credits":3000,"title":"月卡","description":null,"badge_text":null}}'::jsonb, NULL)$$,
    'price 0 rejected'
  );
  PERFORM vip_t3a_test.expect_raise(
    $$SELECT admin.validate_managed_config_value('vip_plans_config', '{"week":{"price_cents":1399,"duration_days":7,"bonus_credits":1,"title":"周卡","description":null,"badge_text":null},"month":{"price_cents":2888,"duration_days":31,"bonus_credits":3000,"title":"月卡","description":null,"badge_text":null}}'::jsonb, NULL)$$,
    'week bonus rejected'
  );
  PERFORM vip_t3a_test.expect_raise(
    $$SELECT admin.validate_managed_config_value('vip_text_discount_rate', '1.1'::jsonb, NULL)$$,
    'discount above 1 rejected'
  );
  PERFORM vip_t3a_test.expect_raise(
    $$SELECT admin.validate_managed_config_value('vip_checkin_bonus_config', '{"mode":"fixed"}'::jsonb, NULL)$$,
    'fixed mode without credits rejected'
  );
  PERFORM vip_t3a_test.expect_raise(
    $$SELECT admin.validate_managed_config_value('vip_checkin_bonus_config', '{"mode":"same_as_base","fixed_credits":10}'::jsonb, NULL)$$,
    'same_as_base with fixed credits rejected'
  );
  PERFORM vip_t3a_test.expect_raise(
    $$SELECT admin.validate_managed_config_value('feature_free_trial_limits', '{"voice":-1,"basic_image":3}'::jsonb, NULL)$$,
    'negative free trial rejected'
  );
  PERFORM admin.validate_managed_config_value('feature_free_trial_limits', '{"voice":0,"basic_image":3}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('feature_free_trial_limits', '{"voice":20,"basic_image":20}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('vip_text_discount_rate', '1'::jsonb, NULL);

  PERFORM vip_t3a_test.expect_raise(
    $$INSERT INTO billing.payment_orders (
      id, user_id, status, payment_type, amount_cents, credits_amount, bonus_credits, expires_at,
      product_type, product_id, vip_duration_days, vip_bonus_credits
    ) VALUES (
      'VIP_BAD_WEEK', '00000000-0000-4000-8000-0000000000d9', 'pending', 'wxpay', 1399, 0, 0,
      now() + interval '1 hour', 'vip', 'week', 7, 5
    )$$,
    'week bonus snapshot rejected by table check'
  );

  INSERT INTO billing.feature_free_trials (
    user_id, feature, reference_id, ordinal, status, reserved_until
  ) VALUES (
    u_limit, 'voice', 'ordinal-20', 20, 'reserved', now() + interval '1 hour'
  );
  PERFORM vip_t3a_test.expect_raise(
    format(
      $$INSERT INTO billing.feature_free_trials (
        user_id, feature, reference_id, ordinal, status, reserved_until
      ) VALUES ('%s', 'voice', 'ordinal-21', 21, 'reserved', now() + interval '1 hour')$$,
      u_limit
    ),
    'ordinal 21 rejected'
  );
  DELETE FROM billing.feature_free_trials WHERE reference_id = 'ordinal-20';

  v_limits := (SELECT value FROM app_core.runtime_config WHERE key = 'feature_free_trial_limits');
  DELETE FROM app_core.runtime_config WHERE key = 'feature_free_trial_limits';
  v_json := billing.reserve_feature_free_trial(u_limit, 'voice', 'missing-1');
  PERFORM vip_t3a_test.assert(
    v_json->>'ok' = 'true' AND (v_json->'quota'->>'free_trial_limit')::int = 3,
    'missing config keeps default limit 3'
  );
  PERFORM billing.reserve_feature_free_trial(u_limit, 'voice', 'missing-2');
  PERFORM billing.reserve_feature_free_trial(u_limit, 'voice', 'missing-3');
  v_json := billing.reserve_feature_free_trial(u_limit, 'voice', 'missing-4');
  PERFORM vip_t3a_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'default fourth is exhausted');
  INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
  VALUES ('feature_free_trial_limits', v_limits, 'restored', 1, now(), NULL);

  UPDATE app_core.runtime_config
  SET value = '{"voice":0,"basic_image":3}'::jsonb
  WHERE key = 'feature_free_trial_limits';
  v_json := billing.reserve_feature_free_trial(u_zero, 'voice', 'zero-1');
  PERFORM vip_t3a_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'limit 0 allocates nothing');
  PERFORM vip_t3a_test.assert(
    (SELECT count(*) FROM billing.feature_free_trials WHERE reference_id = 'zero-1') = 0,
    'limit 0 writes no fact'
  );
  v_json := billing.reserve_feature_free_trial(u_zero, 'basic_image', 'zero-image');
  PERFORM vip_t3a_test.assert((v_json->'fact'->>'ordinal')::int = 1, 'image limit stays independent');

  UPDATE app_core.runtime_config
  SET value = '{"voice":4,"basic_image":3}'::jsonb
  WHERE key = 'feature_free_trial_limits';
  FOR i IN 1..3 LOOP
    PERFORM billing.consume_feature_free_trial(u_lower, 'voice', 'no-such');
  END LOOP;
  PERFORM billing.reserve_feature_free_trial(u_lower, 'voice', 'lower-1');
  PERFORM billing.reserve_feature_free_trial(u_lower, 'voice', 'lower-2');
  PERFORM billing.reserve_feature_free_trial(u_lower, 'voice', 'lower-3');
  UPDATE app_core.runtime_config
  SET value = '{"voice":2,"basic_image":3}'::jsonb
  WHERE key = 'feature_free_trial_limits';
  v_json := billing.reserve_feature_free_trial(u_lower, 'voice', 'lower-4');
  PERFORM vip_t3a_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'lowered limit stops new rows');
  PERFORM vip_t3a_test.assert(
    (SELECT count(*) FROM billing.feature_free_trials WHERE user_id = u_lower AND feature = 'voice') = 3,
    'lowered limit keeps historical facts'
  );
  v_json := billing.reserve_feature_free_trial(u_lower, 'voice', 'lower-1');
  PERFORM vip_t3a_test.assert(v_json->>'status' = 'already_reserved', 'replay after lowering still returns the old row');

  UPDATE app_core.runtime_config
  SET value = '{"voice":4,"basic_image":3}'::jsonb
  WHERE key = 'feature_free_trial_limits';
  v_json := billing.reserve_feature_free_trial(u_raise, 'voice', 'raise-1');
  PERFORM billing.reserve_feature_free_trial(u_raise, 'voice', 'raise-2');
  PERFORM billing.reserve_feature_free_trial(u_raise, 'voice', 'raise-3');
  v_json := billing.reserve_feature_free_trial(u_raise, 'voice', 'raise-4');
  PERFORM vip_t3a_test.assert((v_json->'fact'->>'ordinal')::int = 4, 'raised limit continues at the next ordinal');
  v_json := billing.reserve_feature_free_trial(u_raise, 'voice', 'raise-5');
  PERFORM vip_t3a_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'raised limit still stops at 4');

  UPDATE app_core.runtime_config
  SET value = v_limits
  WHERE key = 'feature_free_trial_limits';
  PERFORM vip_t3a_test.assert(
    (SELECT count(*) FROM billing.feature_free_trials WHERE user_id = u_lower AND status = 'reserved') = 3,
    'restoring the limit does not rewrite historical facts'
  );

  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
  VALUES
    (u_checkin_vip, now() - interval '1 day', now() + interval '5 days', 'week'),
    (u_checkin_fixed, now() - interval '1 day', now() + interval '5 days', 'week'),
    (u_checkin_bad, now() - interval '1 day', now() + interval '5 days', 'week');

  v_json := miniapp_features.claim_daily_checkin(u_checkin_vip);
  PERFORM vip_t3a_test.assert(
    (v_json->'checkin'->>'reward_credits')::int = 120
    AND (v_json->'checkin'->>'vip_reward_credits')::int = 60
    AND v_json->'checkin'->>'vip_checkin_mode' = 'same_as_base'
    AND (v_json->'checkin'->>'vip_checkin_config_fallback')::boolean = false,
    'default check-in bonus matches the base reward'
  );
  v_reward := (SELECT reward_credits FROM miniapp_features.daily_checkins WHERE user_id = u_checkin_vip);
  UPDATE app_core.runtime_config
  SET value = '{"mode":"fixed","fixed_credits":1}'::jsonb
  WHERE key = 'vip_checkin_bonus_config';
  PERFORM vip_t3a_test.assert(
    (SELECT reward_credits FROM miniapp_features.daily_checkins WHERE user_id = u_checkin_vip) = v_reward,
    'check-in config rollback does not rewrite the claimed row'
  );

  v_json := miniapp_features.claim_daily_checkin(u_checkin_fixed);
  PERFORM vip_t3a_test.assert(
    (v_json->'checkin'->>'reward_credits')::int = 61
    AND (v_json->'checkin'->>'vip_reward_credits')::int = 1
    AND v_json->'checkin'->>'vip_checkin_mode' = 'fixed',
    'fixed check-in bonus uses the published integer'
  );

  UPDATE app_core.runtime_config
  SET value = '{"mode":"fixed"}'::jsonb
  WHERE key = 'vip_checkin_bonus_config';
  v_json := miniapp_features.claim_daily_checkin(u_checkin_bad);
  PERFORM vip_t3a_test.assert(
    (v_json->'checkin'->>'reward_credits')::int = 120
    AND (v_json->'checkin'->>'vip_checkin_config_fallback')::boolean = true,
    'damaged fixed config falls back to same_as_base'
  );

  UPDATE app_core.runtime_config
  SET value = '{"mode":"fixed","fixed_credits":10}'::jsonb
  WHERE key = 'vip_checkin_bonus_config';
  v_json := miniapp_features.claim_daily_checkin(u_checkin_plain);
  PERFORM vip_t3a_test.assert(
    (v_json->'checkin'->>'reward_credits')::int = 60
    AND (v_json->'checkin'->>'vip_reward_credits')::int = 0,
    'non-VIP ignores the fixed bonus'
  );
  UPDATE app_core.runtime_config
  SET value = '{"mode":"same_as_base"}'::jsonb
  WHERE key = 'vip_checkin_bonus_config';

  UPDATE app_core.runtime_config
  SET value = jsonb_set(value, '{week,price_cents}', '9999'::jsonb)
  WHERE key = 'vip_plans_config';
  INSERT INTO billing.payment_orders (
    id, user_id, status, payment_type, amount_cents, credits_amount, bonus_credits, expires_at,
    product_type, product_id, vip_duration_days, vip_bonus_credits
  ) VALUES
    ('VIP_OLD_WEEK', u_order_old, 'pending', 'wxpay', 1399, 0, 0, now() + interval '1 hour', 'vip', 'week', 7, 0),
    ('VIP_NEW_WEEK', u_order_new, 'pending', 'wxpay', 2000, 0, 0, now() + interval '1 hour', 'vip', 'week', 10, 0),
    ('VIP_NEW_MONTH', u_order_month, 'pending', 'wxpay', 3000, 0, 0, now() + interval '1 hour', 'vip', 'month', 31, 100);
  PERFORM billing.complete_payment_order('VIP_OLD_WEEK', 'old', 'webhook');
  PERFORM billing.complete_payment_order('VIP_NEW_WEEK', 'new', 'query');
  PERFORM billing.complete_payment_order('VIP_NEW_MONTH', 'month', 'cron');

  SELECT round(extract(epoch FROM (valid_until - valid_from)) / 86400)
  INTO v_days
  FROM billing.vip_memberships
  WHERE user_id = u_order_old;
  PERFORM vip_t3a_test.assert(v_days = 7, 'old week snapshot stays 7 days after a price change');
  SELECT amount_cents, duration_days, bonus_credits
  INTO v_count, v_reward, v_days
  FROM billing.vip_purchase_grants
  WHERE order_id = 'VIP_OLD_WEEK';
  PERFORM vip_t3a_test.assert(v_count = 1399 AND v_reward = 7 AND v_days = 0, 'old grant is unchanged');

  SELECT round(extract(epoch FROM (valid_until - valid_from)) / 86400)
  INTO v_days
  FROM billing.vip_memberships
  WHERE user_id = u_order_new;
  PERFORM vip_t3a_test.assert(v_days = 10, 'new week snapshot uses 10 days, not the later config');
  SELECT bonus_credits INTO v_bonus FROM billing.user_wallets WHERE user_id = u_order_month;
  PERFORM vip_t3a_test.assert(v_bonus = 100, 'month bonus uses the order snapshot');

  UPDATE app_core.runtime_config
  SET value = jsonb_set(
    jsonb_set(value, '{week,price_cents}', '1399'::jsonb),
    '{month,bonus_credits}',
    '9'::jsonb
  )
  WHERE key = 'vip_plans_config';
  PERFORM vip_t3a_test.assert(
    (SELECT amount_cents FROM billing.payment_orders WHERE id = 'VIP_NEW_WEEK') = 2000
    AND (SELECT bonus_credits FROM billing.vip_purchase_grants WHERE order_id = 'VIP_NEW_MONTH') = 100
    AND (SELECT bonus_credits FROM billing.user_wallets WHERE user_id = u_order_month) = 100,
    'rolling the plan config back does not rewrite orders, grants or bonus balance'
  );

  RETURN 'ok';
END;
$fn$;

SELECT vip_t3a_test.run();
