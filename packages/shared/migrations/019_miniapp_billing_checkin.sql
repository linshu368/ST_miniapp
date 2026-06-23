-- MiniApp billing/check-in refinement.
-- - Model-tier chat cost is now configured as a runtime_config dictionary.
-- - Chat requests reserve client_message_id before generation and only charge
--   after assistant content is delivered.
-- - Daily check-in rewards bonus credits every 24 hours.

INSERT INTO miniapp.runtime_config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_model_tier_credit_costs',
  '{"tier_1": 1, "tier_2": 2, "tier_3": 4, "tier_4": 8}'::jsonb,
  'MiniApp 模型档次到每次聊天扣费星尘数的映射。模型可在档次间切换，运营只调整档次扣费。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO miniapp.runtime_config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_daily_checkin_bonus_credits',
  '10'::jsonb,
  'MiniApp 每次签到赠送的 bonus 星尘数，签到间隔为 24 小时。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE miniapp.chat_message_charges
  DROP CONSTRAINT IF EXISTS chat_message_charges_status_check;

ALTER TABLE miniapp.chat_message_charges
  ADD CONSTRAINT chat_message_charges_status_check
  CHECK (status IN ('reserved', 'charged', 'refunded'));

ALTER TABLE miniapp.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;

ALTER TABLE miniapp.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('recharge', 'chat_debit', 'refund', 'adjustment', 'checkin_bonus'));

CREATE TABLE IF NOT EXISTS miniapp.daily_checkins (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reward_credits INTEGER NOT NULL CHECK (reward_credits > 0),
  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_miniapp_daily_checkins_user_claimed
  ON miniapp.daily_checkins(user_id, claimed_at DESC);

ALTER TABLE miniapp.daily_checkins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.daily_checkins FROM anon, authenticated;
GRANT ALL ON miniapp.daily_checkins TO service_role, postgres;

CREATE OR REPLACE FUNCTION miniapp.reserve_chat_message(
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

  IF FOUND AND v_existing.status IN ('reserved', 'charged') THEN
    SELECT *
    INTO v_wallet
    FROM miniapp.user_wallets
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'charge_status', CASE WHEN v_existing.status = 'charged' THEN 'already_charged' ELSE 'already_reserved' END,
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
    'reserved',
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (user_id, session_id, client_message_id) DO UPDATE
  SET
    amount = EXCLUDED.amount,
    status = 'reserved',
    wallet_ledger_id = NULL,
    refunded_at = NULL,
    refund_ledger_id = NULL;

  RETURN jsonb_build_object(
    'charge_status', 'reserved',
    'wallet', to_jsonb(v_wallet)
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.finalize_chat_message_charge(
  p_user_id UUID,
  p_session_id UUID,
  p_client_message_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_charge miniapp.chat_message_charges;
  v_bonus_to_deduct INTEGER;
  v_main_to_deduct INTEGER;
  v_ledger_id UUID;
BEGIN
  SELECT *
  INTO v_charge
  FROM miniapp.chat_message_charges
  WHERE user_id = p_user_id
    AND session_id = p_session_id
    AND client_message_id = p_client_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat charge reservation not found: %', p_client_message_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_wallet
  FROM miniapp.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found: %', p_user_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_charge.status = 'charged' THEN
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet)
    );
  END IF;

  IF v_charge.status <> 'reserved' THEN
    RAISE EXCEPTION 'chat charge is not reserved: %', p_client_message_id
      USING ERRCODE = '22023';
  END IF;

  IF v_charge.amount = 0 THEN
    UPDATE miniapp.chat_message_charges
    SET status = 'charged'
    WHERE user_id = p_user_id
      AND session_id = p_session_id
      AND client_message_id = p_client_message_id;

    RETURN jsonb_build_object(
      'charge_status', 'charged',
      'wallet', to_jsonb(v_wallet)
    );
  END IF;

  IF v_wallet.main_credits + v_wallet.bonus_credits < v_charge.amount THEN
    RAISE EXCEPTION 'insufficient credits: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, v_charge.amount);
  v_main_to_deduct := v_charge.amount - v_bonus_to_deduct;

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
    -v_charge.amount,
    -v_main_to_deduct,
    -v_bonus_to_deduct,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'chat_message',
    p_client_message_id,
    jsonb_build_object('session_id', p_session_id)
  )
  RETURNING id INTO v_ledger_id;

  UPDATE miniapp.chat_message_charges
  SET
    status = 'charged',
    wallet_ledger_id = v_ledger_id,
    refunded_at = NULL,
    refund_ledger_id = NULL
  WHERE user_id = p_user_id
    AND session_id = p_session_id
    AND client_message_id = p_client_message_id;

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

  IF v_charge.status = 'reserved' OR v_charge.amount = 0 OR v_charge.wallet_ledger_id IS NULL THEN
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

CREATE OR REPLACE FUNCTION miniapp.claim_daily_checkin(
  p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_last_claimed_at TIMESTAMPTZ;
  v_reward INTEGER;
  v_ledger_id UUID;
  v_claimed_at TIMESTAMPTZ := now();
BEGIN
  SELECT claimed_at
  INTO v_last_claimed_at
  FROM miniapp.daily_checkins
  WHERE user_id = p_user_id
  ORDER BY claimed_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_last_claimed_at > v_claimed_at - interval '24 hours' THEN
    RAISE EXCEPTION 'daily check-in is not ready: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(
    floor(
      COALESCE(
        (SELECT NULLIF(value #>> '{}', '')::numeric FROM miniapp.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits'),
        10
      )
    )::integer,
    10
  )
  INTO v_reward;

  IF v_reward <= 0 THEN
    RAISE EXCEPTION 'daily check-in reward must be positive: %', v_reward
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO miniapp.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE miniapp.user_wallets
  SET
    bonus_credits = bonus_credits + v_reward,
    updated_at = v_claimed_at
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
    'checkin_bonus',
    v_reward,
    0,
    v_reward,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'daily_checkin',
    p_user_id::text,
    jsonb_build_object('claimed_at', v_claimed_at)
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO miniapp.daily_checkins (
    user_id,
    reward_credits,
    claimed_at
  ) VALUES (
    p_user_id,
    v_reward,
    v_claimed_at
  );

  RETURN jsonb_build_object(
    'wallet', to_jsonb(v_wallet),
    'checkin', jsonb_build_object(
      'claimed_at', v_claimed_at,
      'next_claim_at', v_claimed_at + interval '24 hours',
      'reward_credits', v_reward,
      'wallet_ledger_id', v_ledger_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.reserve_chat_message(UUID, UUID, TEXT, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.finalize_chat_message_charge(UUID, UUID, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.refund_chat_message_charge(UUID, UUID, TEXT, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.claim_daily_checkin(UUID) TO service_role, postgres;

COMMENT ON TABLE miniapp.daily_checkins IS
  'MiniApp 每日签到记录，奖励写入 user_wallets.bonus_credits。';

COMMENT ON FUNCTION miniapp.reserve_chat_message(UUID, UUID, TEXT, INTEGER) IS
  '聊天生成前预留 client_message_id 幂等键并检查余额，不实际扣费。';

COMMENT ON FUNCTION miniapp.finalize_chat_message_charge(UUID, UUID, TEXT) IS
  '聊天确认有 assistant 内容后执行实际扣费并写钱包流水。';
