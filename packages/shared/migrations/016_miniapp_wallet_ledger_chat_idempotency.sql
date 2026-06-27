-- 016: MiniApp 钱包流水、聊天扣费幂等与失败补偿
--
-- 目标：
--   - 建立 MiniApp 独立钱包流水表，支持充值、聊天扣费、退款审计
--   - 聊天消息按 client_message_id 幂等扣费，避免网络重试重复扣款
--   - AI 生成失败时可按同一 client_message_id 原路退款

CREATE TABLE IF NOT EXISTS miniapp.wallet_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_type     TEXT NOT NULL CHECK (entry_type IN ('recharge', 'chat_debit', 'refund', 'adjustment')),
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

CREATE TABLE IF NOT EXISTS miniapp.chat_message_charges (
  user_id            UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id         UUID NOT NULL,
  client_message_id  TEXT NOT NULL,
  amount             INTEGER NOT NULL CHECK (amount > 0),
  status             TEXT NOT NULL CHECK (status IN ('charged', 'refunded')),
  wallet_ledger_id   UUID REFERENCES miniapp.wallet_ledger(id),
  refund_ledger_id   UUID REFERENCES miniapp.wallet_ledger(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at        TIMESTAMPTZ,
  PRIMARY KEY (user_id, session_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS idx_miniapp_chat_charges_session
  ON miniapp.chat_message_charges(session_id, created_at DESC);

ALTER TABLE miniapp.wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.chat_message_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.wallet_ledger FROM anon, authenticated;
REVOKE ALL ON miniapp.chat_message_charges FROM anon, authenticated;
GRANT ALL ON miniapp.wallet_ledger TO service_role, postgres;
GRANT ALL ON miniapp.chat_message_charges TO service_role, postgres;

CREATE OR REPLACE FUNCTION miniapp.charge_chat_message(
  p_user_id UUID,
  p_session_id UUID,
  p_client_message_id TEXT,
  p_amount INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_existing miniapp.chat_message_charges;
  v_bonus_to_deduct INTEGER;
  v_main_to_deduct INTEGER;
  v_ledger_id UUID;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'charge amount must be positive: %', p_amount
      USING ERRCODE = '22023';
  END IF;

  IF p_client_message_id IS NULL OR length(trim(p_client_message_id)) = 0 THEN
    RAISE EXCEPTION 'client_message_id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_existing
  FROM miniapp.chat_message_charges
  WHERE user_id = p_user_id
    AND session_id = p_session_id
    AND client_message_id = p_client_message_id
  FOR UPDATE;

  IF FOUND AND v_existing.status = 'charged' THEN
    SELECT *
    INTO v_wallet
    FROM miniapp.user_wallets
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet)
    );
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
    'chat_debit',
    -p_amount,
    -v_main_to_deduct,
    -v_bonus_to_deduct,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'chat_message',
    p_client_message_id,
    jsonb_build_object('session_id', p_session_id)
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO miniapp.chat_message_charges (
    user_id,
    session_id,
    client_message_id,
    amount,
    status,
    wallet_ledger_id,
    refunded_at,
    refund_ledger_id
  ) VALUES (
    p_user_id,
    p_session_id,
    p_client_message_id,
    p_amount,
    'charged',
    v_ledger_id,
    NULL,
    NULL
  )
  ON CONFLICT (user_id, session_id, client_message_id) DO UPDATE
  SET
    amount = EXCLUDED.amount,
    status = 'charged',
    wallet_ledger_id = EXCLUDED.wallet_ledger_id,
    refunded_at = NULL,
    refund_ledger_id = NULL;

  RETURN jsonb_build_object(
    'charge_status', 'charged',
    'wallet', to_jsonb(v_wallet)
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.refund_chat_message_charge(
  p_user_id UUID,
  p_session_id UUID,
  p_client_message_id TEXT,
  p_reason TEXT DEFAULT 'ai_generation_failed'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_charge miniapp.chat_message_charges;
  v_original_ledger miniapp.wallet_ledger;
  v_wallet miniapp.user_wallets;
  v_refund_main INTEGER;
  v_refund_bonus INTEGER;
  v_refund_amount INTEGER;
  v_refund_ledger_id UUID;
BEGIN
  SELECT *
  INTO v_charge
  FROM miniapp.chat_message_charges
  WHERE user_id = p_user_id
    AND session_id = p_session_id
    AND client_message_id = p_client_message_id
  FOR UPDATE;

  IF NOT FOUND OR v_charge.status = 'refunded' THEN
    SELECT *
    INTO v_wallet
    FROM miniapp.user_wallets
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'refund_status', 'already_refunded',
      'wallet', to_jsonb(v_wallet)
    );
  END IF;

  SELECT *
  INTO v_original_ledger
  FROM miniapp.wallet_ledger
  WHERE id = v_charge.wallet_ledger_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'original charge ledger not found: %', v_charge.wallet_ledger_id
      USING ERRCODE = 'P0002';
  END IF;

  v_refund_main := -v_original_ledger.main_delta;
  v_refund_bonus := -v_original_ledger.bonus_delta;
  v_refund_amount := v_refund_main + v_refund_bonus;

  UPDATE miniapp.user_wallets
  SET
    main_credits = main_credits + v_refund_main,
    bonus_credits = bonus_credits + v_refund_bonus,
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
    'refund',
    v_refund_amount,
    v_refund_main,
    v_refund_bonus,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'chat_message',
    p_client_message_id,
    jsonb_build_object('session_id', p_session_id, 'reason', p_reason)
  )
  RETURNING id INTO v_refund_ledger_id;

  UPDATE miniapp.chat_message_charges
  SET
    status = 'refunded',
    refunded_at = now(),
    refund_ledger_id = v_refund_ledger_id
  WHERE user_id = p_user_id
    AND session_id = p_session_id
    AND client_message_id = p_client_message_id;

  RETURN jsonb_build_object(
    'refund_status', 'refunded',
    'wallet', to_jsonb(v_wallet)
  );
END;
$$;

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

GRANT EXECUTE ON FUNCTION miniapp.charge_chat_message(UUID, UUID, TEXT, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.refund_chat_message_charge(UUID, UUID, TEXT, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.complete_payment_order(TEXT, TEXT) TO service_role, postgres;

COMMENT ON TABLE miniapp.wallet_ledger IS
  'MiniApp 独立钱包流水表，记录充值、聊天扣费、退款和人工调整。';

COMMENT ON TABLE miniapp.chat_message_charges IS
  'MiniApp 聊天扣费幂等表，按 user/session/client_message_id 防重复扣费。';
