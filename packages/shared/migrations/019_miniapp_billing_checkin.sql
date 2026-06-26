-- 019: MiniApp daily check-in rewards.
--
-- 目标：
--   - 配置每日签到赠送 bonus 星尘数
--   - 每 24 小时允许领取一次签到奖励

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

ALTER TABLE miniapp.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;

ALTER TABLE miniapp.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('recharge', 'adjustment', 'checkin_bonus'));

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

GRANT EXECUTE ON FUNCTION miniapp.claim_daily_checkin(UUID) TO service_role, postgres;

COMMENT ON TABLE miniapp.daily_checkins IS
  'MiniApp 每日签到记录，奖励写入 user_wallets.bonus_credits。';
