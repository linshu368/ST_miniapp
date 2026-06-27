-- 015: MiniApp 用户设置、钱包扣费与支付订单过期补充
--
-- 目标：
--   - MiniApp 用户设置独立落在 miniapp schema，不复用 Bot/ST settings 表
--   - 聊天扣费只扣 miniapp.user_wallets，不读写 public.users / bot_users 积分字段
--   - pending 支付订单到期后可落库为 expired，避免只在读取时临时展示

CREATE TABLE IF NOT EXISTS miniapp.miniapp_user_settings (
  user_id                  UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  tg_username              TEXT,
  tg_first_name            TEXT,
  tg_last_name             TEXT,
  display_name             TEXT,
  avatar_url               TEXT,
  total_round              BIGINT NOT NULL DEFAULT 0,
  pref_word_count          TEXT NOT NULL DEFAULT '300-500'
                            CHECK (pref_word_count IN ('100-300', '300-500', '500-800', '800+')),
  pref_show_options        BOOLEAN NOT NULL DEFAULT true,
  pref_custom_instructions TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS miniapp.runtime_config (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  description TEXT,
  version     INTEGER DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  text_value  TEXT
);

ALTER TABLE miniapp.miniapp_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.runtime_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.miniapp_user_settings FROM anon, authenticated;
REVOKE ALL ON miniapp.runtime_config FROM anon, authenticated;
GRANT ALL ON miniapp.miniapp_user_settings TO service_role, postgres;
GRANT ALL ON miniapp.runtime_config TO service_role, postgres;

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

  -- 先消耗赠送积分，再消耗主积分；充值所得主积分保留到最后。
  v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, p_amount);
  v_main_to_deduct := p_amount - v_bonus_to_deduct;

  UPDATE miniapp.user_wallets
  SET
    bonus_credits = bonus_credits - v_bonus_to_deduct,
    main_credits = main_credits - v_main_to_deduct,
    updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  RETURN v_wallet;
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.expire_payment_orders(
  p_user_id UUID DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE miniapp.payment_orders
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at <= now()
    AND (p_user_id IS NULL OR user_id = p_user_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

INSERT INTO miniapp.runtime_config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_chat_message_credit_cost',
  '1'::jsonb,
  'MiniApp 每次用户发送聊天消息扣除的星尘数。仅扣 miniapp.user_wallets。',
  1,
  now(),
  '1'
)
ON CONFLICT (key) DO NOTHING;

GRANT EXECUTE ON FUNCTION miniapp.deduct_wallet_credits(UUID, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.expire_payment_orders(UUID) TO service_role, postgres;

COMMENT ON TABLE miniapp.miniapp_user_settings IS
  'MiniApp 独立用户设置表。与 Bot/ST settings 表隔离。';

COMMENT ON FUNCTION miniapp.deduct_wallet_credits(UUID, INTEGER) IS
  'MiniApp 钱包扣费函数：先扣赠送积分，再扣主积分；余额不足时抛错。';

COMMENT ON FUNCTION miniapp.expire_payment_orders(UUID) IS
  'MiniApp 支付订单过期落库函数：将已过期 pending 订单更新为 expired。';
