-- 024: Restore real MiniApp LLM credit deduction.
--
-- 目标：
--   - 适配上游 llm-proxy 成功响应后的 wallets.deduct() 调用
--   - 扣费只操作 miniapp.user_wallets，不触碰 ST、Bot 或 public.users 积分字段
--   - 先扣 bonus_credits，再扣 main_credits，并写入钱包流水

ALTER TABLE miniapp.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;

ALTER TABLE miniapp.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('recharge', 'adjustment', 'checkin_bonus', 'wish_reward', 'llm_debit'));

CREATE OR REPLACE FUNCTION miniapp.deduct_wallet_credits(
  p_user_id UUID,
  p_amount INTEGER
) RETURNS miniapp.user_wallets
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_bonus_to_deduct INTEGER;
  v_main_to_deduct INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'deduct amount must be positive: %', p_amount
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO miniapp.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM miniapp.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found: %', p_user_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_wallet.main_credits + v_wallet.bonus_credits < p_amount THEN
    RAISE EXCEPTION 'insufficient credits: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, p_amount);
  v_main_to_deduct := p_amount - v_bonus_to_deduct;

  UPDATE miniapp.user_wallets
  SET
    bonus_credits = bonus_credits - v_bonus_to_deduct,
    main_credits = main_credits - v_main_to_deduct,
    updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  INSERT INTO miniapp.wallet_ledger (
    user_id,
    entry_type,
    amount,
    main_delta,
    bonus_delta,
    balance_main,
    balance_bonus,
    reference_type,
    reference_id,
    metadata
  ) VALUES (
    p_user_id,
    'llm_debit',
    -p_amount,
    -v_main_to_deduct,
    -v_bonus_to_deduct,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'llm_proxy',
    NULL,
    jsonb_build_object('source', 'llm_proxy')
  );

  RETURN v_wallet;
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.deduct_wallet_credits(UUID, INTEGER) TO service_role, postgres;

COMMENT ON FUNCTION miniapp.deduct_wallet_credits(UUID, INTEGER) IS
  'MiniApp LLM 扣费函数：成功生成后先扣赠送积分，再扣主积分，并写 llm_debit 钱包流水。';
