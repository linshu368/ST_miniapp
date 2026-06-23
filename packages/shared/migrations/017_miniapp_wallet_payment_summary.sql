-- 017: MiniApp 钱包支付汇总字段
--
-- 目标：
--   - 将 Bot / public.users 中原有的钱包汇总字段补到 miniapp.user_wallets
--   - MiniApp 自己维护首次付费、最近付费、累计付费金额和总积分
--   - 充值到账时同步更新钱包汇总和钱包流水

ALTER TABLE miniapp.user_wallets
  ADD COLUMN IF NOT EXISTS first_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE miniapp.user_wallets
  ADD COLUMN IF NOT EXISTS total_credits INTEGER
  GENERATED ALWAYS AS (main_credits + bonus_credits) STORED;

CREATE OR REPLACE FUNCTION miniapp.complete_payment_order(
  p_order_id TEXT,
  p_provider_transaction_id TEXT
) RETURNS miniapp.payment_orders
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order miniapp.payment_orders;
  v_wallet miniapp.user_wallets;
  v_paid_amount NUMERIC(12, 2);
BEGIN
  SELECT *
  INTO v_order
  FROM miniapp.payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found: %', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status = 'completed' AND v_order.credits_added = true THEN
    RETURN v_order;
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'payment order is not pending: %', p_order_id
      USING ERRCODE = 'P0001';
  END IF;

  v_paid_amount := (v_order.amount_cents::NUMERIC / 100)::NUMERIC(12, 2);

  UPDATE miniapp.payment_orders
  SET
    status = 'completed',
    provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
    credits_added = true,
    paid_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  INSERT INTO miniapp.user_wallets (
    user_id,
    main_credits,
    bonus_credits,
    first_paid_at,
    last_paid_at,
    total_paid_amount,
    updated_at
  ) VALUES (
    v_order.user_id,
    v_order.credits_amount,
    v_order.bonus_credits,
    now(),
    now(),
    v_paid_amount,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    main_credits = miniapp.user_wallets.main_credits + EXCLUDED.main_credits,
    bonus_credits = miniapp.user_wallets.bonus_credits + EXCLUDED.bonus_credits,
    first_paid_at = COALESCE(miniapp.user_wallets.first_paid_at, EXCLUDED.first_paid_at),
    last_paid_at = EXCLUDED.last_paid_at,
    total_paid_amount = miniapp.user_wallets.total_paid_amount + EXCLUDED.total_paid_amount,
    updated_at = now()
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
    v_order.user_id,
    'recharge',
    v_order.credits_amount + v_order.bonus_credits,
    v_order.credits_amount,
    v_order.bonus_credits,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'payment_order',
    v_order.id,
    jsonb_build_object(
      'provider_transaction_id', p_provider_transaction_id,
      'paid_amount', v_paid_amount
    )
  );

  RETURN v_order;
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.complete_payment_order(TEXT, TEXT) TO service_role, postgres;

COMMENT ON COLUMN miniapp.user_wallets.first_paid_at IS
  'MiniApp 用户首次成功充值时间。';

COMMENT ON COLUMN miniapp.user_wallets.last_paid_at IS
  'MiniApp 用户最近一次成功充值时间。';

COMMENT ON COLUMN miniapp.user_wallets.total_paid_amount IS
  'MiniApp 用户累计成功充值金额，单位为人民币元。';

COMMENT ON COLUMN miniapp.user_wallets.total_credits IS
  'MiniApp 用户当前总积分，生成列：main_credits + bonus_credits。';
