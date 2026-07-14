-- 031: New-user wallet grant and daily check-in reward adjustment.
-- - Every newly inserted miniapp.users row receives 600 bonus credits exactly once.
-- - Daily check-in grants 60 bonus credits (30 T2 messages at 2 credits/message).

INSERT INTO miniapp.runtime_config AS config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_new_user_signup_bonus_credits',
  '600'::jsonb,
  'MiniApp 新用户首次进入时赠送的 bonus 星尘数。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  version = config.version + 1,
  updated_at = now(),
  text_value = NULL;

INSERT INTO miniapp.runtime_config AS config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_daily_checkin_bonus_credits',
  '60'::jsonb,
  'MiniApp 每次签到赠送的 bonus 星尘数，签到间隔为 24 小时。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  version = config.version + 1,
  updated_at = now(),
  text_value = NULL;

CREATE OR REPLACE FUNCTION miniapp.grant_new_user_signup_bonus(
  p_user_id UUID
) RETURNS miniapp.user_wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = miniapp, public
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_bonus INTEGER;
BEGIN
  SELECT COALESCE(
    floor(
      COALESCE(
        (
          SELECT NULLIF(value #>> '{}', '')::numeric
          FROM miniapp.runtime_config
          WHERE key = 'miniapp_new_user_signup_bonus_credits'
        ),
        600
      )
    )::integer,
    600
  )
  INTO v_bonus;

  IF v_bonus <= 0 THEN
    RAISE EXCEPTION 'new user signup bonus must be positive: %', v_bonus
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

  IF EXISTS (
    SELECT 1
    FROM miniapp.wallet_ledger
    WHERE user_id = p_user_id
      AND entry_type = 'adjustment'
      AND metadata ->> 'reason' = 'signup_bonus'
  ) THEN
    RETURN v_wallet;
  END IF;

  UPDATE miniapp.user_wallets
  SET
    bonus_credits = bonus_credits + v_bonus,
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
    'adjustment',
    v_bonus,
    0,
    v_bonus,
    v_wallet.main_credits,
    v_wallet.bonus_credits,
    'signup_bonus',
    p_user_id::text,
    jsonb_build_object('reason', 'signup_bonus')
  );

  RETURN v_wallet;
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.grant_wallet_on_user_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = miniapp, public
AS $$
BEGIN
  PERFORM miniapp.grant_new_user_signup_bonus(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_miniapp_new_user_wallet_bonus ON miniapp.users;
CREATE TRIGGER trg_miniapp_new_user_wallet_bonus
AFTER INSERT ON miniapp.users
FOR EACH ROW
EXECUTE FUNCTION miniapp.grant_wallet_on_user_insert();

REVOKE ALL ON FUNCTION miniapp.grant_new_user_signup_bonus(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp.grant_new_user_signup_bonus(UUID) TO service_role, postgres;

COMMENT ON FUNCTION miniapp.grant_new_user_signup_bonus(UUID) IS
  '幂等地为 MiniApp 新用户创建钱包并赠送一次注册 bonus 星尘。';
COMMENT ON TRIGGER trg_miniapp_new_user_wallet_bonus ON miniapp.users IS
  '新建 MiniApp 用户后自动赠送注册 bonus 星尘。';
