-- Allow MiniApp free-chat mode (cost = 0) to keep request idempotency.
-- A zero-amount charge reserves client_message_id without changing wallet balance
-- or writing wallet ledger rows.

ALTER TABLE miniapp.chat_message_charges
  DROP CONSTRAINT IF EXISTS chat_message_charges_amount_check;

ALTER TABLE miniapp.chat_message_charges
  DROP CONSTRAINT IF EXISTS chat_message_charges_amount_non_negative;

ALTER TABLE miniapp.chat_message_charges
  ADD CONSTRAINT chat_message_charges_amount_non_negative CHECK (amount >= 0);

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
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'charge amount must be non-negative: %', p_amount
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

  IF p_amount = 0 THEN
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
      0,
      'charged',
      NULL,
      NULL,
      NULL
    )
    ON CONFLICT (user_id, session_id, client_message_id) DO UPDATE
    SET
      amount = 0,
      status = 'charged',
      wallet_ledger_id = NULL,
      refunded_at = NULL,
      refund_ledger_id = NULL;

    RETURN jsonb_build_object(
      'charge_status', 'charged',
      'wallet', to_jsonb(v_wallet)
    );
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

  IF v_charge.amount = 0 THEN
    SELECT *
    INTO v_wallet
    FROM miniapp.user_wallets
    WHERE user_id = p_user_id;

    UPDATE miniapp.chat_message_charges
    SET
      status = 'refunded',
      refunded_at = now(),
      refund_ledger_id = NULL
    WHERE user_id = p_user_id
      AND session_id = p_session_id
      AND client_message_id = p_client_message_id;

    RETURN jsonb_build_object(
      'refund_status', 'refunded',
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

GRANT EXECUTE ON FUNCTION miniapp.charge_chat_message(UUID, UUID, TEXT, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.refund_chat_message_charge(UUID, UUID, TEXT, TEXT) TO service_role, postgres;

COMMENT ON CONSTRAINT chat_message_charges_amount_non_negative
  ON miniapp.chat_message_charges IS
  'amount = 0 表示免费聊天模式下的幂等占位，不产生扣费流水。';
