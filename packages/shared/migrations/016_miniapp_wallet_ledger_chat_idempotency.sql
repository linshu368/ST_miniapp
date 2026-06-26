-- 016: MiniApp 钱包流水
--
-- 目标：
--   - 建立 MiniApp 独立钱包流水表，记录充值和运营调整
--   - 充值到账时同步写入钱包流水，便于审计

CREATE TABLE IF NOT EXISTS miniapp.wallet_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_type     TEXT NOT NULL CHECK (entry_type IN ('recharge', 'adjustment')),
  amount         INTEGER NOT NULL CHECK (amount <> 0),
  main_delta     INTEGER NOT NULL DEFAULT 0,
  bonus_delta    INTEGER NOT NULL DEFAULT 0,
  balance_main   INTEGER NOT NULL CHECK (balance_main >= 0),
  balance_bonus  INTEGER NOT NULL CHECK (balance_bonus >= 0),
  reference_type TEXT,
  reference_id   TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_miniapp_wallet_ledger_user_created
  ON miniapp.wallet_ledger(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_miniapp_wallet_ledger_reference
  ON miniapp.wallet_ledger(reference_type, reference_id);

ALTER TABLE miniapp.wallet_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.wallet_ledger FROM anon, authenticated;
GRANT ALL ON miniapp.wallet_ledger TO service_role, postgres;

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
    updated_at
  ) VALUES (
    v_order.user_id,
    v_order.credits_amount,
    v_order.bonus_credits,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    main_credits = miniapp.user_wallets.main_credits + EXCLUDED.main_credits,
    bonus_credits = miniapp.user_wallets.bonus_credits + EXCLUDED.bonus_credits,
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
    jsonb_build_object('provider_transaction_id', p_provider_transaction_id)
  );

  RETURN v_order;
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.complete_payment_order(TEXT, TEXT) TO service_role, postgres;

COMMENT ON TABLE miniapp.wallet_ledger IS
  'MiniApp 独立钱包流水表，记录充值、奖励和运营调整。';
