-- 020: MiniApp role wish collection.
-- - Store private role wishes submitted from the Telegram bot.
-- - Reward the first valid wish step with a small bonus credit.
-- - Limit each Telegram user to one rewarded wish every 24 hours.

ALTER TABLE miniapp.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;

ALTER TABLE miniapp.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('recharge', 'adjustment', 'checkin_bonus', 'wish_reward'));

CREATE TABLE IF NOT EXISTS miniapp.wish_roles (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     BIGINT NOT NULL,
  db_user_id                  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  wish_text                   TEXT NOT NULL CHECK (char_length(trim(wish_text)) > 8),
  extra_text                  TEXT,
  total_paid_amount_at_submit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reward_credits              INTEGER NOT NULL DEFAULT 1 CHECK (reward_credits > 0),
  status                      TEXT NOT NULL DEFAULT 'awaiting_extra'
    CHECK (status IN ('awaiting_extra', 'completed')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_miniapp_wish_roles_user_created
  ON miniapp.wish_roles(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_miniapp_wish_roles_status_created
  ON miniapp.wish_roles(status, created_at DESC);

ALTER TABLE miniapp.wish_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.wish_roles FROM anon, authenticated;
GRANT ALL ON miniapp.wish_roles TO service_role, postgres;

CREATE TABLE IF NOT EXISTS miniapp.wish_role_sessions (
  user_id    BIGINT PRIMARY KEY,
  db_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL CHECK (state IN ('awaiting_wish')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE miniapp.wish_role_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.wish_role_sessions FROM anon, authenticated;
GRANT ALL ON miniapp.wish_role_sessions TO service_role, postgres;

CREATE OR REPLACE FUNCTION miniapp.create_wish_role(
  p_db_user_id UUID,
  p_telegram_user_id BIGINT,
  p_wish_text TEXT,
  p_reward_credits INTEGER DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_trimmed TEXT := trim(p_wish_text);
  v_wallet miniapp.user_wallets;
  v_wish miniapp.wish_roles;
  v_ledger_id UUID;
BEGIN
  IF char_length(v_trimmed) <= 8 THEN
    RAISE EXCEPTION 'wish text too short'
      USING ERRCODE = '22023';
  END IF;

  IF p_reward_credits <= 0 THEN
    RAISE EXCEPTION 'wish reward must be positive: %', p_reward_credits
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(p_telegram_user_id);

  IF EXISTS (
    SELECT 1
    FROM miniapp.wish_roles
    WHERE user_id = p_telegram_user_id
      AND created_at > v_now - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'wish limit reached: %', p_telegram_user_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO miniapp.user_wallets (user_id)
  VALUES (p_db_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM miniapp.user_wallets
  WHERE user_id = p_db_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found: %', p_db_user_id
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO miniapp.wish_roles (
    user_id,
    db_user_id,
    wish_text,
    total_paid_amount_at_submit,
    reward_credits,
    status,
    created_at
  ) VALUES (
    p_telegram_user_id,
    p_db_user_id,
    v_trimmed,
    COALESCE(v_wallet.total_paid_amount, 0),
    p_reward_credits,
    'awaiting_extra',
    v_now
  )
  RETURNING * INTO v_wish;

  UPDATE miniapp.user_wallets
  SET
    bonus_credits = bonus_credits + p_reward_credits,
    updated_at = v_now
  WHERE user_id = p_db_user_id
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
    p_db_user_id,
    'wish_reward',
    p_reward_credits,
    0,
    p_reward_credits,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'wish_role',
    v_wish.id::text,
    jsonb_build_object(
      'telegram_user_id', p_telegram_user_id,
      'wish_text_length', char_length(v_trimmed)
    )
  )
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'wish', to_jsonb(v_wish),
    'wallet', to_jsonb(v_wallet),
    'wallet_ledger_id', v_ledger_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.complete_wish_role(
  p_db_user_id UUID,
  p_telegram_user_id BIGINT,
  p_wish_id UUID,
  p_extra_text TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wish miniapp.wish_roles;
  v_extra TEXT := NULLIF(trim(COALESCE(p_extra_text, '')), '');
BEGIN
  SELECT *
  INTO v_wish
  FROM miniapp.wish_roles
  WHERE id = p_wish_id
    AND user_id = p_telegram_user_id
    AND (db_user_id = p_db_user_id OR db_user_id IS NULL)
    AND status = 'awaiting_extra'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE miniapp.wish_roles
  SET
    extra_text = v_extra,
    status = 'completed',
    closed_at = now()
  WHERE id = v_wish.id
  RETURNING * INTO v_wish;

  RETURN to_jsonb(v_wish);
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.create_wish_role(UUID, BIGINT, TEXT, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.complete_wish_role(UUID, BIGINT, UUID, TEXT) TO service_role, postgres;

COMMENT ON TABLE miniapp.wish_roles IS
  'MiniApp 私密角色许愿记录，供运营用 SQL 查询消费。';

COMMENT ON TABLE miniapp.wish_role_sessions IS
  'Telegram Bot 角色许愿轻量状态表，用于等待用户输入第一步许愿内容。';
