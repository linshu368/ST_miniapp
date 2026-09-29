-- Local T4 LLM charge/refund scenarios. Throwaway database only.

CREATE SCHEMA IF NOT EXISTS vip_t4_test;

CREATE OR REPLACE FUNCTION vip_t4_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T4 scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t4_test.charge(
  p_user UUID,
  p_key UUID,
  p_generation TEXT,
  p_amount NUMERIC,
  p_policy TEXT,
  p_category TEXT,
  p_finish TEXT,
  p_markup NUMERIC DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN billing.charge_llm_usage(
    p_key,
    p_generation,
    p_user,
    'model',
    'vendor/model',
    '模型',
    1,
    1,
    NULL,
    1,
    p_markup,
    p_amount,
    false,
    jsonb_build_object(
      'billing_mode', 'fixed_tier',
      'chat_status', 'success',
      'finish_reason', p_finish,
      'wallet_policy', p_policy,
      'payable_credits', p_amount,
      'fixed_deduction', p_amount,
      'fixed_deduction_category', p_category,
      'original_credits', p_amount,
      'model_tier', p_category
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION vip_t4_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  u_mix UUID := '00000000-0000-4000-8000-0000000000b1';
  u_bonus UUID := '00000000-0000-4000-8000-0000000000b2';
  u_main UUID := '00000000-0000-4000-8000-0000000000b3';
  u_free UUID := '00000000-0000-4000-8000-0000000000b4';
  u_old UUID := '00000000-0000-4000-8000-0000000000b5';
  v_json JSONB;
  v_main NUMERIC;
  v_bonus NUMERIC;
  v_count INTEGER;
  v_status TEXT;
  v_key UUID;
  v_ledger UUID;
BEGIN
  INSERT INTO app_core.users (id)
  VALUES (u_mix), (u_bonus), (u_main), (u_free), (u_old)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits)
  VALUES
    (u_mix, 20, 30),
    (u_bonus, 0, 80),
    (u_main, 100, 40),
    (u_free, 15, 0),
    (u_old, 40, 10)
  ON CONFLICT (user_id) DO UPDATE
  SET main_credits = EXCLUDED.main_credits, bonus_credits = EXCLUDED.bonus_credits;

  -- 免费优先：实付 0，余额不动。
  v_json := vip_t4_test.charge(u_free, '00000000-0000-4000-8000-000000000101', 'gen-free', 0, 'main_then_bonus', 'light', 'stop', 0);
  PERFORM vip_t4_test.assert(v_json ->> 'charge_status' = 'free', 'free status');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_free;
  PERFORM vip_t4_test.assert(v_main = 15 AND v_bonus = 0, 'free wallet unchanged');

  -- 只有专项：轻量可扣，旗舰整笔拒绝。
  v_json := vip_t4_test.charge(u_bonus, '00000000-0000-4000-8000-000000000102', 'gen-bonus', 30, 'main_then_bonus', 'light', 'stop');
  PERFORM vip_t4_test.assert(v_json ->> 'charge_status' = 'charged', 'bonus light charged');
  PERFORM vip_t4_test.assert((v_json -> 'charge' -> 'metadata' ->> 'main_delta')::NUMERIC = 0, 'bonus light main delta');
  PERFORM vip_t4_test.assert((v_json -> 'charge' -> 'metadata' ->> 'bonus_delta')::NUMERIC = -30, 'bonus light bonus delta');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_bonus;
  PERFORM vip_t4_test.assert(v_main = 0 AND v_bonus = 50, 'bonus light wallet');

  BEGIN
    PERFORM vip_t4_test.charge(u_bonus, '00000000-0000-4000-8000-000000000103', 'gen-bonus-prem', 30, 'main_only', 'premium', 'stop');
    PERFORM vip_t4_test.assert(false, 'premium bonus-only should fail');
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      PERFORM vip_t4_test.assert(SQLERRM = 'MAIN_CREDITS_INSUFFICIENT', 'premium bonus-only code');
  END;
  SELECT count(*) INTO v_count FROM billing.llm_usage_charges
  WHERE charge_key = '00000000-0000-4000-8000-000000000103';
  PERFORM vip_t4_test.assert(v_count = 0, 'premium bonus-only wrote no charge');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_bonus;
  PERFORM vip_t4_test.assert(v_main = 0 AND v_bonus = 50, 'premium bonus-only wallet unchanged');

  -- 组合扣：先充值再专项。
  v_json := vip_t4_test.charge(u_mix, '00000000-0000-4000-8000-000000000104', 'gen-mix', 40, 'main_then_bonus', 'light', 'stop');
  PERFORM vip_t4_test.assert((v_json -> 'charge' -> 'metadata' ->> 'main_delta')::NUMERIC = -20, 'mix main');
  PERFORM vip_t4_test.assert((v_json -> 'charge' -> 'metadata' ->> 'bonus_delta')::NUMERIC = -20, 'mix bonus');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_mix;
  PERFORM vip_t4_test.assert(v_main = 0 AND v_bonus = 10, 'mix wallet');

  -- 重复扣款不二次入账。
  v_json := vip_t4_test.charge(u_mix, '00000000-0000-4000-8000-000000000104', 'gen-mix', 40, 'main_then_bonus', 'light', 'stop');
  PERFORM vip_t4_test.assert(v_json ->> 'charge_status' = 'already_charged', 'replay status');
  SELECT count(*) INTO v_count FROM billing.wallet_ledger WHERE debit_key = '00000000-0000-4000-8000-000000000104';
  PERFORM vip_t4_test.assert(v_count = 1, 'replay ledger count');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_mix;
  PERFORM vip_t4_test.assert(v_main = 0 AND v_bonus = 10, 'replay wallet');

  -- 受理快照：pending 记 48，之后用 999 重放仍扣 48。
  v_key := '00000000-0000-4000-8000-000000000105';
  v_json := vip_t4_test.charge(u_main, v_key, 'gen-snap', 48, 'main_only', 'premium', NULL);
  PERFORM vip_t4_test.assert(v_json ->> 'charge_status' = 'pending', 'snapshot pending');
  SELECT main_credits INTO v_main FROM billing.user_wallets WHERE user_id = u_main;
  PERFORM vip_t4_test.assert(v_main = 100, 'pending does not debit');

  v_json := billing.charge_llm_usage(
    v_key, 'gen-snap', u_main, 'model', 'vendor/model', '模型', 1, 1, NULL, 1, 1, 999, false,
    jsonb_build_object(
      'billing_mode', 'fixed_tier',
      'chat_status', 'success',
      'finish_reason', 'stop',
      'wallet_policy', 'main_only',
      'payable_credits', 999,
      'fixed_deduction', 999,
      'fixed_deduction_category', 'premium',
      'original_credits', 999
    )
  );
  PERFORM vip_t4_test.assert((v_json -> 'charge' ->> 'charged_amount')::NUMERIC = 48, 'snapshot payable wins');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_main;
  PERFORM vip_t4_test.assert(v_main = 52 AND v_bonus = 40, 'snapshot wallet uses main only');

  -- 处理中余额竞态：pending 后 main 不够，不写 partial。
  v_key := '00000000-0000-4000-8000-000000000106';
  PERFORM vip_t4_test.charge(u_main, v_key, 'gen-race', 80, 'main_only', 'premium', NULL);
  UPDATE billing.user_wallets SET main_credits = 10, bonus_credits = 100 WHERE user_id = u_main;
  BEGIN
    PERFORM vip_t4_test.charge(u_main, v_key, 'gen-race', 80, 'main_only', 'premium', 'stop');
    PERFORM vip_t4_test.assert(false, 'race should fail closed');
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      PERFORM vip_t4_test.assert(SQLERRM = 'MAIN_CREDITS_INSUFFICIENT', 'race code');
  END;
  SELECT status INTO v_status FROM billing.llm_usage_charges WHERE charge_key = v_key;
  PERFORM vip_t4_test.assert(v_status = 'pending', 'race keeps pending');
  SELECT count(*) INTO v_count FROM billing.llm_usage_charges WHERE user_id = u_main AND status = 'partial';
  PERFORM vip_t4_test.assert(v_count = 0, 'race writes no partial');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_main;
  PERFORM vip_t4_test.assert(v_main = 10 AND v_bonus = 100, 'race wallet unchanged');

  -- 历史 partial 只读，第二次调用不补扣。
  INSERT INTO billing.llm_usage_charges (
    charge_key, generation_id, user_id, model_openrouter_id, model_display_name,
    exchange_rate, model_markup, calculated_amount, charged_amount, status, metadata
  ) VALUES (
    '00000000-0000-4000-8000-000000000107', 'gen-old', u_old, 'vendor/model', '模型',
    1, 1, 30, 10, 'partial', '{"legacy":true}'::jsonb
  );
  v_json := vip_t4_test.charge(u_old, '00000000-0000-4000-8000-000000000107', 'gen-old', 30, 'main_only', 'premium', 'stop');
  PERFORM vip_t4_test.assert(v_json ->> 'charge_status' = 'already_charged', 'legacy partial replay');
  SELECT status, charged_amount INTO v_status, v_main FROM billing.llm_usage_charges
  WHERE charge_key = '00000000-0000-4000-8000-000000000107';
  PERFORM vip_t4_test.assert(v_status = 'partial' AND v_main = 10, 'legacy partial unchanged');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_old;
  PERFORM vip_t4_test.assert(v_main = 40 AND v_bonus = 10, 'legacy partial wallet');

  -- 没有 debit_key 的历史扣款不能退。
  INSERT INTO billing.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
    reference_type, reference_id, metadata
  ) VALUES (
    u_old, 'chat_debit', -10, -10, 0, 30, 10, 'llm_usage', 'legacy-debit', '{}'::jsonb
  ) RETURNING id INTO v_ledger;
  INSERT INTO billing.llm_usage_charges (
    charge_key, generation_id, user_id, model_openrouter_id, model_display_name,
    exchange_rate, model_markup, calculated_amount, charged_amount, status, debit_ledger_id
  ) VALUES (
    '00000000-0000-4000-8000-000000000108', 'gen-legacy-debit', u_old, 'vendor/model', '模型',
    1, 1, 10, 10, 'charged', v_ledger
  );
  v_json := billing.refund_llm_usage_charge('00000000-0000-4000-8000-000000000108', 'legacy');
  PERFORM vip_t4_test.assert(v_json ->> 'status' = 'not_refundable', 'legacy debit not refundable');
  SELECT main_credits INTO v_main FROM billing.user_wallets WHERE user_id = u_old;
  PERFORM vip_t4_test.assert(v_main = 40, 'legacy refund did not move wallet');

  -- 原路退款与重复退款。用 u_mix 上已经扣过的 40。
  v_json := billing.refund_llm_usage_charge('00000000-0000-4000-8000-000000000104', 'post_debit_failure');
  PERFORM vip_t4_test.assert(v_json ->> 'status' = 'refunded', 'refund status');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_mix;
  PERFORM vip_t4_test.assert(v_main = 20 AND v_bonus = 30, 'refund restored split');
  SELECT metadata ->> 'compensation_status' INTO v_status
  FROM billing.llm_usage_charges WHERE charge_key = '00000000-0000-4000-8000-000000000104';
  PERFORM vip_t4_test.assert(v_status = 'refunded', 'charge marked refunded');
  v_json := billing.refund_llm_usage_charge('00000000-0000-4000-8000-000000000104', 'again');
  PERFORM vip_t4_test.assert(v_json ->> 'status' = 'already_refunded', 'duplicate refund');
  SELECT main_credits, bonus_credits INTO v_main, v_bonus FROM billing.user_wallets WHERE user_id = u_mix;
  PERFORM vip_t4_test.assert(v_main = 20 AND v_bonus = 30, 'duplicate refund wallet');
  SELECT count(*) INTO v_count FROM billing.wallet_ledger
  WHERE user_id = u_mix AND entry_type = 'refund';
  PERFORM vip_t4_test.assert(v_count = 1, 'one refund ledger');

  RETURN 'ok';
END;
$$;

SELECT vip_t4_test.run();
