-- Local T2 regression scenarios. Run only against a throwaway database.

CREATE SCHEMA IF NOT EXISTS vip_t2_test;

CREATE OR REPLACE FUNCTION vip_t2_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T2 scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t2_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  u1 UUID := '00000000-0000-4000-8000-000000000001';
  u2 UUID := '00000000-0000-4000-8000-000000000002';
  u3 UUID := '00000000-0000-4000-8000-000000000003';
  v_json JSONB;
  v_wallet billing.user_wallets;
  v_order billing.payment_orders;
  v_until_1 TIMESTAMPTZ;
  v_until_2 TIMESTAMPTZ;
  v_count INTEGER;
  v_main NUMERIC;
  v_bonus NUMERIC;
  v_raised BOOLEAN;
  v_until TIMESTAMPTZ;
BEGIN
  INSERT INTO app_core.users (id) VALUES (u1), (u2), (u3)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits)
  VALUES (u1, 100, 40), (u2, 0, 50), (u3, 20, 5)
  ON CONFLICT (user_id) DO UPDATE
  SET main_credits = EXCLUDED.main_credits, bonus_credits = EXCLUDED.bonus_credits;

  -- main enough
  v_json := billing.apply_wallet_debit(u1, 'debit-main', 'main_only', 30, 'chat_debit', 'test', 'debit-main');
  PERFORM vip_t2_test.assert(v_json->>'status' = 'debited', 'main enough should debit');
  PERFORM vip_t2_test.assert((v_json->'split'->>'main_credits')::numeric = 30, 'main enough split');
  PERFORM vip_t2_test.assert((v_json->'split'->>'bonus_credits')::numeric = 0, 'main enough no bonus');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u1;
  PERFORM vip_t2_test.assert(v_main = 70 AND v_bonus = 40 AND v_main + v_bonus = 110, 'main enough wallet');

  -- replay same debit_key
  v_json := billing.apply_wallet_debit(u1, 'debit-main', 'main_only', 30, 'chat_debit', 'test', 'debit-main');
  PERFORM vip_t2_test.assert(v_json->>'status' = 'already_debited', 'debit replay');
  SELECT count(*) INTO v_count FROM billing.wallet_ledger WHERE debit_key = 'debit-main';
  PERFORM vip_t2_test.assert(v_count = 1, 'debit replay one ledger');

  -- main insufficient, bonus covers (main_then_bonus)
  v_json := billing.apply_wallet_debit(u1, 'debit-mix', 'main_then_bonus', 90, 'chat_debit', 'test', 'debit-mix');
  PERFORM vip_t2_test.assert(v_json->>'status' = 'debited', 'mix debit');
  PERFORM vip_t2_test.assert((v_json->'split'->>'main_credits')::numeric = 70, 'mix uses remaining main');
  PERFORM vip_t2_test.assert((v_json->'split'->>'bonus_credits')::numeric = 20, 'mix uses bonus remainder');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u1;
  PERFORM vip_t2_test.assert(v_main = 0 AND v_bonus = 20, 'mix wallet leftover');

  -- total insufficient, zero partial
  v_raised := false;
  BEGIN
    v_json := billing.apply_wallet_debit(u1, 'debit-short', 'main_then_bonus', 50, 'chat_debit', 'test', 'debit-short');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := SQLERRM = 'TOTAL_CREDITS_INSUFFICIENT';
  END;
  PERFORM vip_t2_test.assert(v_raised, 'total insufficient raises');
  SELECT count(*) INTO v_count FROM billing.wallet_ledger WHERE debit_key = 'debit-short';
  PERFORM vip_t2_test.assert(v_count = 0, 'total insufficient no ledger');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u1;
  PERFORM vip_t2_test.assert(v_main = 0 AND v_bonus = 20, 'total insufficient no wallet change');

  -- main_only with only bonus
  v_raised := false;
  BEGIN
    v_json := billing.apply_wallet_debit(u2, 'debit-bonus-only', 'main_only', 10, 'chat_debit', 'test', 'debit-bonus-only');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := SQLERRM = 'MAIN_CREDITS_INSUFFICIENT';
  END;
  PERFORM vip_t2_test.assert(v_raised, 'main_only bonus-only rejects');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u2;
  PERFORM vip_t2_test.assert(v_main = 0 AND v_bonus = 50, 'main_only reject no change');

  -- refund split matches debit, replay, second key on same debit
  v_json := billing.refund_wallet_debit('refund-mix', 'debit-mix');
  PERFORM vip_t2_test.assert(v_json->>'status' = 'refunded', 'refund once');
  PERFORM vip_t2_test.assert((v_json->'split'->>'main_credits')::numeric = 70, 'refund main');
  PERFORM vip_t2_test.assert((v_json->'split'->>'bonus_credits')::numeric = 20, 'refund bonus');
  v_json := billing.refund_wallet_debit('refund-mix', 'debit-mix');
  PERFORM vip_t2_test.assert(v_json->>'status' = 'already_refunded', 'same refund_key replay');
  v_json := billing.refund_wallet_debit('refund-mix-2', 'debit-mix');
  PERFORM vip_t2_test.assert(v_json->>'status' = 'already_refunded', 'different refund_key same debit');
  SELECT count(*) INTO v_count FROM billing.wallet_refunds WHERE debit_ledger_id IN (
    SELECT id FROM billing.wallet_ledger WHERE debit_key = 'debit-mix'
  );
  PERFORM vip_t2_test.assert(v_count = 1, 'one refund fact');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u1;
  PERFORM vip_t2_test.assert(v_main = 70 AND v_bonus = 40, 'refund restored mix');

  v_raised := false;
  BEGIN
    v_json := billing.refund_wallet_debit('refund-mix', 'debit-main');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := true;
  END;
  PERFORM vip_t2_test.assert(v_raised, 'refund_key cannot attach to a different debit');

  v_raised := false;
  BEGIN
    v_json := billing.apply_wallet_debit(u1, 'debit-frac', 'main_only', 1.5, 'chat_debit', 'test', 'debit-frac');
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := SQLERRM = 'INVALID_AMOUNT';
  END;
  PERFORM vip_t2_test.assert(v_raised, 'non-integer debit amount rejected');

  -- credits payment still works
  INSERT INTO billing.payment_orders (
    id, user_id, status, payment_type, amount_cents, credits_amount, bonus_credits, expires_at
  ) VALUES (
    'CREDITS_1', u3, 'pending', 'wxpay', 600, 600, 0, now() + interval '1 hour'
  );
  v_order := billing.complete_payment_order('CREDITS_1', 'tx-c', 'webhook');
  PERFORM vip_t2_test.assert(v_order.fulfillment_applied AND v_order.product_type = 'credits', 'credits fulfillment');
  v_order := billing.complete_payment_order('CREDITS_1', 'tx-c', 'query');
  PERFORM vip_t2_test.assert(v_order.settled_by = 'webhook', 'credits replay keeps first settled_by');
  SELECT count(*) INTO v_count FROM billing.wallet_ledger
  WHERE reference_type = 'payment_order' AND reference_id = 'CREDITS_1' AND entry_type = 'recharge';
  PERFORM vip_t2_test.assert(v_count = 1, 'credits replay one recharge ledger');

  -- VIP week then month serial extend; month bonus once
  INSERT INTO billing.payment_orders (
    id, user_id, status, payment_type, amount_cents, credits_amount, bonus_credits, expires_at,
    product_type, product_id, vip_duration_days, vip_bonus_credits
  ) VALUES
    ('VIP_WEEK_1', u3, 'pending', 'wxpay', 1399, 0, 0, now() + interval '1 hour', 'vip', 'week', 7, 0),
    ('VIP_MONTH_1', u3, 'pending', 'wxpay', 2888, 0, 0, now() + interval '1 hour', 'vip', 'month', 31, 3000),
    ('VIP_WEEK_REPLAY', u3, 'pending', 'wxpay', 1399, 0, 0, now() + interval '1 hour', 'vip', 'week', 7, 0);

  v_order := billing.complete_payment_order('VIP_WEEK_1', 'tx-w', 'webhook');
  v_until_1 := v_order.vip_valid_until;
  PERFORM vip_t2_test.assert(v_order.fulfillment_applied AND NOT v_order.credits_added, 'week fulfillment');
  v_order := billing.complete_payment_order('VIP_WEEK_1', 'tx-w', 'cron');
  PERFORM vip_t2_test.assert(v_order.vip_valid_until = v_until_1, 'week replay same until');
  SELECT count(*) INTO v_count FROM billing.vip_purchase_grants WHERE order_id = 'VIP_WEEK_1';
  PERFORM vip_t2_test.assert(v_count = 1, 'week grant once');
  SELECT bonus_credits INTO v_bonus FROM billing.user_wallets WHERE user_id = u3;
  PERFORM vip_t2_test.assert(v_bonus = 5, 'week grants no vip bonus');

  v_order := billing.complete_payment_order('VIP_MONTH_1', 'tx-m', 'return');
  v_until_2 := v_order.vip_valid_until;
  PERFORM vip_t2_test.assert(v_until_2 = v_until_1 + interval '31 days', 'month extends week');
  SELECT bonus_credits INTO v_bonus FROM billing.user_wallets WHERE user_id = u3;
  PERFORM vip_t2_test.assert(v_bonus = 3005, 'month 3000 bonus once');
  v_order := billing.complete_payment_order('VIP_MONTH_1', 'tx-m', 'query');
  SELECT count(*) INTO v_count FROM billing.wallet_ledger WHERE entry_type = 'vip_bonus' AND reference_id = 'VIP_MONTH_1';
  PERFORM vip_t2_test.assert(v_count = 1, 'month bonus ledger once');

  -- free trials 1/2/3/4 and isolation
  v_json := billing.reserve_feature_free_trial(u1, 'voice', 'voice-1');
  PERFORM vip_t2_test.assert(v_json->>'ok' = 'true' AND (v_json->'fact'->>'ordinal')::int = 1, 'voice 1');
  PERFORM vip_t2_test.assert((billing.consume_feature_free_trial(u1, 'voice', 'voice-1')->>'status') = 'consumed', 'voice consume 1');
  v_json := billing.reserve_feature_free_trial(u1, 'voice', 'voice-2');
  PERFORM vip_t2_test.assert((v_json->'fact'->>'ordinal')::int = 2, 'voice 2');
  PERFORM vip_t2_test.assert((billing.consume_feature_free_trial(u1, 'voice', 'voice-2')->>'status') = 'consumed', 'voice consume 2');
  v_json := billing.reserve_feature_free_trial(u1, 'voice', 'voice-3');
  PERFORM vip_t2_test.assert((v_json->'fact'->>'ordinal')::int = 3, 'voice 3');
  PERFORM vip_t2_test.assert((billing.release_feature_free_trial(u1, 'voice', 'voice-3')->>'status') = 'released', 'voice release 3');
  v_json := billing.reserve_feature_free_trial(u1, 'voice', 'voice-3b');
  PERFORM vip_t2_test.assert((v_json->'fact'->>'ordinal')::int = 3, 'released slot reusable');
  PERFORM vip_t2_test.assert((billing.consume_feature_free_trial(u1, 'voice', 'voice-3b')->>'status') = 'consumed', 'voice consume 3');
  v_json := billing.reserve_feature_free_trial(u1, 'voice', 'voice-4');
  PERFORM vip_t2_test.assert(v_json->>'ok' = 'false' AND v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'voice 4 exhausted');

  v_json := billing.reserve_feature_free_trial(u1, 'basic_image', 'img-1');
  PERFORM vip_t2_test.assert(v_json->>'ok' = 'true' AND (v_json->'fact'->>'ordinal')::int = 1, 'image isolated from voice');

  -- late consume after reclaim
  v_json := billing.reserve_feature_free_trial(u2, 'voice', 'late-1', 30);
  UPDATE billing.feature_free_trials SET reserved_until = now() - interval '1 second' WHERE reference_id = 'late-1';
  PERFORM billing.reclaim_expired_feature_free_trials(u2, 'voice');
  v_json := billing.consume_feature_free_trial(u2, 'voice', 'late-1');
  PERFORM vip_t2_test.assert(v_json->>'ok' = 'false' AND v_json->>'code' = 'FEATURE_FREE_TRIAL_INVALID_STATE', 'late consume after reclaim');

  -- late consume: consume itself reclaims expired reserved rows
  v_json := billing.reserve_feature_free_trial(u2, 'basic_image', 'late-2', 30);
  UPDATE billing.feature_free_trials SET reserved_until = now() - interval '1 second' WHERE reference_id = 'late-2';
  v_json := billing.consume_feature_free_trial(u2, 'basic_image', 'late-2');
  PERFORM vip_t2_test.assert(v_json->>'ok' = 'false' AND v_json->>'code' = 'FEATURE_FREE_TRIAL_INVALID_STATE', 'late consume auto-reclaim');

  -- reminder business_key + shanghai window
  SELECT valid_until INTO v_until FROM billing.vip_memberships WHERE user_id = u3;
  UPDATE billing.vip_memberships
  SET valid_until = ((now() AT TIME ZONE 'Asia/Shanghai')::date + 3 + time '18:00') AT TIME ZONE 'Asia/Shanghai'
  WHERE user_id = u3
  RETURNING valid_until INTO v_until;
  v_json := miniapp_features.insert_vip_expiry_reminder(
    u3, 'expiring_soon', v_until, 'VIP 即将到期', '您的 VIP 即将到期', '/vip'
  );
  PERFORM vip_t2_test.assert(v_json->>'status' = 'inserted', 'reminder insert');
  v_json := miniapp_features.insert_vip_expiry_reminder(
    u3, 'expiring_soon', v_until, 'VIP 即将到期', '您的 VIP 即将到期', '/vip'
  );
  PERFORM vip_t2_test.assert(v_json->>'status' = 'already_inserted', 'reminder dedupe');
  SELECT count(*) INTO v_count FROM miniapp_features.notifications WHERE kind = 'vip_expiry' AND user_id = u3;
  PERFORM vip_t2_test.assert(v_count = 1, 'one reminder row');

  -- checkin keeps config 40 and exposes vip fields as 0 extra
  v_json := miniapp_features.claim_daily_checkin(u2);
  PERFORM vip_t2_test.assert((v_json->'checkin'->>'reward_credits')::int = 40, 'checkin stays 40');
  PERFORM vip_t2_test.assert((v_json->'checkin'->>'vip_reward_credits')::int = 0, 'checkin vip extra stays 0');
  PERFORM vip_t2_test.assert((v_json->'checkin'->>'base_reward_credits')::int = 40, 'checkin base 40');

  -- permission matrix
  PERFORM vip_t2_test.assert(
    NOT has_table_privilege('anon', 'billing.vip_memberships', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'billing.wallet_refunds', 'INSERT')
    AND NOT has_function_privilege('anon', 'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'billing.complete_payment_order(text,text,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'billing.complete_payment_order(text,text,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'billing.reserve_feature_free_trial(uuid,text,text,integer)', 'EXECUTE')
    AND has_function_privilege('anon', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE'),
    'permission matrix'
  );

  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE oid IN (
    'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure,
    'billing.refund_wallet_debit(text,text,text)'::regprocedure,
    'billing.complete_payment_order(text,text,text)'::regprocedure,
    'billing.reserve_feature_free_trial(uuid,text,text,integer)'::regprocedure,
    'miniapp_features.claim_daily_checkin(uuid)'::regprocedure,
    'miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)'::regprocedure
  )
  AND proconfig @> ARRAY['search_path=pg_catalog'];
  PERFORM vip_t2_test.assert(v_count = 6, 'search_path pg_catalog on new/updated RPCs');

  PERFORM vip_t2_test.assert(
    NOT EXISTS (SELECT 1 FROM billing.user_wallets WHERE main_credits + bonus_credits IS DISTINCT FROM total_credits),
    'wallet conservation'
  );

  RETURN 'vip t2 scenarios passed';
END;
$$;

SELECT vip_t2_test.run();
