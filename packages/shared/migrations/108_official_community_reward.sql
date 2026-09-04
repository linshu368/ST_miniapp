-- 108: 官方 Telegram 社群新成员一次性奖励。
-- 手工执行：先 test，验证后再 production。关闭配置不会删除历史事实。
BEGIN;

-- One-shot migration: fail fast instead of partially reapplying an already-installed feature.
DO $$ BEGIN
  IF to_regclass('miniapp_features.community_reward_claims') IS NOT NULL
    OR to_regclass('miniapp_features.telegram_community_update_receipts') IS NOT NULL THEN
    RAISE EXCEPTION 'official community reward migration is already installed';
  END IF;
END $$;

-- wallet_ledger constraint replacement needs ACCESS EXCLUSIVE; never wait indefinitely.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('app_core.users') IS NULL
    OR to_regclass('app_core.runtime_config') IS NULL
    OR to_regclass('billing.user_wallets') IS NULL
    OR to_regclass('billing.wallet_ledger') IS NULL
    OR to_regclass('miniapp_features.notifications') IS NULL THEN
    RAISE EXCEPTION 'official community reward requires migration 099+';
  END IF;
END $$;

CREATE TABLE miniapp_features.telegram_community_update_receipts (
  update_id BIGINT PRIMARY KEY,
  community_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL CHECK (telegram_user_id ~ '^[0-9]+$'),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  eligible BOOLEAN NOT NULL DEFAULT false,
  result TEXT NOT NULL CHECK (result IN ('eligible', 'ignored', 'unmatched', 'rewarded', 'already_rewarded', 'ineligible', 'disabled', 'failed')),
  processed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX telegram_community_receipt_eligible_idx
  ON miniapp_features.telegram_community_update_receipts
  (community_chat_id, telegram_user_id, occurred_at DESC) WHERE eligible;

CREATE TABLE miniapp_features.community_reward_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id),
  community_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  reward_credits INTEGER NOT NULL CHECK (reward_credits > 0),
  telegram_update_id BIGINT NOT NULL REFERENCES miniapp_features.telegram_community_update_receipts(update_id),
  wallet_ledger_id UUID,
  notification_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, community_chat_id),
  UNIQUE (telegram_update_id)
);

-- 上线前由运维导入当前成员 Telegram ID。该基线保证既有成员即使退群再入群也不可领取。
CREATE TABLE miniapp_features.community_reward_exclusions (
  community_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL CHECK (telegram_user_id ~ '^[0-9]+$'),
  reason TEXT NOT NULL DEFAULT 'preexisting_member',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (community_chat_id, telegram_user_id)
);

ALTER TABLE miniapp_features.telegram_community_update_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.community_reward_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.community_reward_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.telegram_community_update_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON miniapp_features.community_reward_claims FROM PUBLIC, anon, authenticated;
REVOKE ALL ON miniapp_features.community_reward_exclusions FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp_features.telegram_community_update_receipts TO service_role, postgres;
GRANT ALL ON miniapp_features.community_reward_claims TO service_role, postgres;
GRANT ALL ON miniapp_features.community_reward_exclusions TO service_role, postgres;

ALTER TABLE billing.wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (
  entry_type IN ('recharge','chat_debit','refund','adjustment','checkin_bonus','wish_reward','invite_reward','community_reward')
);

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
BEGIN
  IF trim(p_community_chat_id) = '' THEN
    RAISE EXCEPTION 'invalid community reward input' USING ERRCODE = '22023';
  END IF;

  -- The database is the final authorization boundary. Lock the runtime rows so an
  -- operator disabling the campaign cannot race a reward transaction.
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

  -- Serialize claims for one account/community before checking the unique fact.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT || ':' || p_community_chat_id, 0));

  -- Historical claims remain authoritative even if an exclusion baseline is imported later.
  SELECT c.reward_credits, c.granted_at INTO credits, v_granted_at
  FROM miniapp_features.community_reward_claims c
  WHERE c.user_id = p_user_id AND c.community_chat_id = p_community_chat_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'already_rewarded'::TEXT, credits, v_granted_at;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM miniapp_features.community_reward_exclusions e
    WHERE e.community_chat_id = p_community_chat_id AND e.telegram_user_id = p_telegram_user_id
  ) THEN
    RETURN QUERY SELECT 'ineligible'::TEXT, v_config_credits, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM miniapp_features.telegram_community_update_receipts r
    WHERE r.update_id = p_telegram_update_id AND r.eligible
      AND r.telegram_user_id = p_telegram_user_id
      AND r.community_chat_id = p_community_chat_id
      AND r.occurred_at >= v_started_at
  ) THEN
    RETURN QUERY SELECT 'ineligible'::TEXT, v_config_credits, NULL::TIMESTAMPTZ;
    RETURN;
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
    jsonb_build_object('community_chat_id', p_community_chat_id, 'telegram_update_id', p_telegram_update_id))
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

INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value) VALUES
  ('miniapp_official_community_enabled', 'false'::jsonb, '官方社群入口与新发奖总开关', 1, now(), NULL),
  ('miniapp_official_community_chat_id', '"-1003644202312"'::jsonb, 'Telegram 稳定数字 chat_id', 1, now(), NULL),
  ('miniapp_official_community_url', '"https://t.me/MijingAI_Official"'::jsonb, '官方群公开链接', 1, now(), NULL),
  ('miniapp_official_community_fallback_handle', '"@MijingAI_Official"'::jsonb, '跳转失败备用账号', 1, now(), NULL),
  ('miniapp_official_community_reward_credits', '500'::jsonb, '新成员一次性 bonus 星尘', 1, now(), NULL),
  ('miniapp_official_community_reward_started_at', '"2026-09-03T08:11:57.147Z"'::jsonb, '活动启用 ISO 时间', 1, now(), NULL),
  ('miniapp_official_community_copy', '{"title":"加入官方社群","description":"即将为你打开官方纸飞机社群。系统确认已实际入群并完成账户 ID 匹配后，将自动发放 500 星尘。"}'::jsonb, '社群入口展示文案', 1, now(), NULL)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- 回滚：先关闭 miniapp_official_community_enabled。历史 claim/ledger/通知为审计事实，不自动删除。