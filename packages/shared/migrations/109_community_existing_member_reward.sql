-- 109: 允许活动上线前的官方群既有成员经实时成员校验后手动领取一次性奖励。
-- 手工执行：必须先在 test 验证既有成员手动路径和新成员 webhook 自动路径，再执行 production。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 手动验证没有对应的 chat_member update；NULL 明确表示 existing-member 手动路径。
ALTER TABLE miniapp_features.community_reward_claims
  ALTER COLUMN telegram_update_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION miniapp_features.grant_community_join_reward(
  p_user_id UUID,
  p_telegram_user_id TEXT,
  p_community_chat_id TEXT,
  p_reward_credits INTEGER,
  p_telegram_update_id BIGINT
) RETURNS TABLE (status TEXT, credits INTEGER, granted_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_claim_id UUID;
  v_granted_at TIMESTAMPTZ;
  v_wallet billing.user_wallets%ROWTYPE;
  v_ledger_id UUID;
  v_notification_id UUID;
  v_enabled BOOLEAN := false;
  v_config_chat_id TEXT;
  v_config_credits INTEGER;
  v_started_at TIMESTAMPTZ;
  v_is_existing_member BOOLEAN;
BEGIN
  IF trim(p_community_chat_id) = '' THEN
    RAISE EXCEPTION 'invalid community reward input' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM app_core.runtime_config
  WHERE key IN (
    'miniapp_official_community_enabled',
    'miniapp_official_community_chat_id',
    'miniapp_official_community_reward_credits',
    'miniapp_official_community_reward_started_at'
  )
  ORDER BY key
  FOR SHARE;
  SELECT COALESCE((value #>> '{}')::BOOLEAN, false) INTO v_enabled
  FROM app_core.runtime_config WHERE key = 'miniapp_official_community_enabled';
  SELECT NULLIF(value #>> '{}', '') INTO v_config_chat_id
  FROM app_core.runtime_config WHERE key = 'miniapp_official_community_chat_id';
  SELECT NULLIF(value #>> '{}', '')::INTEGER INTO v_config_credits
  FROM app_core.runtime_config WHERE key = 'miniapp_official_community_reward_credits';
  SELECT NULLIF(value #>> '{}', '')::TIMESTAMPTZ INTO v_started_at
  FROM app_core.runtime_config WHERE key = 'miniapp_official_community_reward_started_at';

  IF NOT v_enabled OR v_config_chat_id IS NULL OR v_started_at IS NULL THEN
    RETURN QUERY SELECT 'disabled'::TEXT, COALESCE(v_config_credits, p_reward_credits), NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF v_config_chat_id <> p_community_chat_id OR v_config_credits IS NULL OR v_config_credits <= 0 THEN
    RETURN QUERY SELECT 'ineligible'::TEXT, COALESCE(v_config_credits, 0), NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT || ':' || p_community_chat_id, 0));

  SELECT c.reward_credits, c.granted_at INTO credits, v_granted_at
  FROM miniapp_features.community_reward_claims c
  WHERE c.user_id = p_user_id AND c.community_chat_id = p_community_chat_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'already_rewarded'::TEXT, credits, v_granted_at;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM miniapp_features.community_reward_exclusions e
    WHERE e.community_chat_id = p_community_chat_id AND e.telegram_user_id = p_telegram_user_id
  ) INTO v_is_existing_member;

  IF p_telegram_update_id IS NULL THEN
    IF NOT v_is_existing_member THEN
      RETURN QUERY SELECT 'ineligible'::TEXT, v_config_credits, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
  ELSE
    IF v_is_existing_member OR NOT EXISTS (
      SELECT 1 FROM miniapp_features.telegram_community_update_receipts r
      WHERE r.update_id = p_telegram_update_id AND r.eligible
        AND r.telegram_user_id = p_telegram_user_id
        AND r.community_chat_id = p_community_chat_id
        AND r.occurred_at >= v_started_at
    ) THEN
      RETURN QUERY SELECT 'ineligible'::TEXT, v_config_credits, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
  END IF;

  INSERT INTO miniapp_features.community_reward_claims
    (user_id, community_chat_id, telegram_user_id, reward_credits, telegram_update_id)
  VALUES (p_user_id, p_community_chat_id, p_telegram_user_id, v_config_credits, p_telegram_update_id)
  ON CONFLICT DO NOTHING
  RETURNING id, community_reward_claims.granted_at INTO v_claim_id, v_granted_at;

  IF v_claim_id IS NULL THEN
    SELECT c.reward_credits, c.granted_at INTO credits, v_granted_at
    FROM miniapp_features.community_reward_claims c
    WHERE c.user_id = p_user_id AND c.community_chat_id = p_community_chat_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'ineligible'::TEXT, v_config_credits, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'already_rewarded'::TEXT, credits, v_granted_at;
    RETURN;
  END IF;

  INSERT INTO billing.user_wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  UPDATE billing.user_wallets SET bonus_credits = bonus_credits + v_config_credits, updated_at = now()
    WHERE user_id = p_user_id RETURNING * INTO v_wallet;

  INSERT INTO billing.wallet_ledger
    (user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus, reference_type, reference_id, metadata)
  VALUES (p_user_id, 'community_reward', v_config_credits, 0, v_config_credits,
    v_wallet.main_credits, v_wallet.bonus_credits, 'community_join', v_claim_id::TEXT,
    jsonb_build_object('community_chat_id', p_community_chat_id, 'telegram_update_id', p_telegram_update_id,
      'claim_method', CASE WHEN p_telegram_update_id IS NULL THEN 'existing_member_verification' ELSE 'join_webhook' END))
  RETURNING id INTO v_ledger_id;

  INSERT INTO miniapp_features.notifications
    (scope, category, title, body, user_id, is_published, published_at)
  VALUES ('official', 'system', '您的 ' || v_config_credits || ' 星尘已到账',
    '欢迎加入秘境大家庭！为您赠送' || v_config_credits || '星尘作为见面礼，感谢您的支持与喜爱。',
    p_user_id, true, now())
  RETURNING id INTO v_notification_id;

  UPDATE miniapp_features.community_reward_claims
  SET wallet_ledger_id = v_ledger_id, notification_id = v_notification_id
  WHERE id = v_claim_id;
  RETURN QUERY SELECT 'rewarded'::TEXT, v_config_credits, v_granted_at;
END $$;

REVOKE ALL ON FUNCTION miniapp_features.grant_community_join_reward(UUID,TEXT,TEXT,INTEGER,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.grant_community_join_reward(UUID,TEXT,TEXT,INTEGER,BIGINT) TO service_role, postgres;

COMMIT;

-- 回滚：先关闭活动。仅在不存在 telegram_update_id IS NULL 的 claim 时，恢复迁移 108 的函数，
-- 再执行 ALTER TABLE ... ALTER COLUMN telegram_update_id SET NOT NULL。历史奖励审计事实不自动删除。