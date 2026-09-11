-- 20260911_billing_grant_bonus_credits.sql
-- domain: billing（见 docs/ARCHITECTURE.md §1 铁律 6 与 §5.1）
--
-- R3：奖励发放收口。此前六个发奖 RPC（签到 / 许愿 / 注册奖励 / 运营赠送 / 邀请 / 社群）
-- 各自复制了一遍同样的三段样板：
--
--   INSERT INTO billing.user_wallets (user_id) … ON CONFLICT DO NOTHING;
--   UPDATE billing.user_wallets SET bonus_credits = bonus_credits + X, updated_at = now() … RETURNING *;
--   INSERT INTO billing.wallet_ledger (…, amount, main_delta = 0, bonus_delta = X, balance_*, …);
--
-- 本迁移把这三段收进唯一入口 billing.grant_bonus_credits，六个 RPC 改为调用它。
-- 业务判定（配置读取、去重、上限、通知文案、审计）全部留在各 RPC 里不动，
-- 每个 RPC 落库的钱包终值与流水行（entry_type / reference_* / metadata / balance_*）与改造前逐字段相同。
--
-- 不纳入：充值入账 RPC（动 main_credits 与 first/last_paid_at 等支付字段，形状不同，
-- 且已由 PaymentSettlement 一条路径收口并有 guard）；charge_* / deduct_* 是扣费，不在发奖范围。
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。
-- 前置：105 / 108 / 109 均已执行（下方 DO 块会校验，不满足直接失败，不会半应用）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 0. 前置校验 ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('miniapp_features.claim_daily_checkin(uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 miniapp_features.claim_daily_checkin';
  END IF;
  IF to_regprocedure('miniapp_features.create_wish_role(uuid,bigint,text,integer)') IS NULL THEN
    RAISE EXCEPTION '缺少 miniapp_features.create_wish_role';
  END IF;
  IF to_regprocedure('billing.grant_new_user_signup_bonus(uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 billing.grant_new_user_signup_bonus';
  END IF;
  IF to_regprocedure('admin.grant_user_credits(uuid,integer,text,text,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.grant_user_credits（066）';
  END IF;
  IF to_regprocedure('miniapp_traffic.grant_invite_reward(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 miniapp_traffic.grant_invite_reward，请先执行 105_invite_program.sql';
  END IF;
  IF to_regprocedure('miniapp_features.grant_community_join_reward(uuid,text,text,integer,bigint)') IS NULL THEN
    RAISE EXCEPTION '缺少 miniapp_features.grant_community_join_reward，请先执行 108 / 109';
  END IF;
  -- 109 整体替换了 108 的函数体；本迁移复制的是 109 版本，prod 若还停在 108 会被这里拦下。
  IF pg_get_functiondef('miniapp_features.grant_community_join_reward(uuid,text,text,integer,bigint)'::regprocedure)
     !~ 'existing_member_verification' THEN
    RAISE EXCEPTION 'grant_community_join_reward 不是 109 版本，请先执行 109_community_existing_member_reward.sql';
  END IF;
END $$;

-- ── 1. 唯一发奖入口 ────────────────────────────────────────────────────────
-- 只做三件事：保证钱包行存在、加 bonus_credits、记一条 amount = bonus_delta 的流水。
-- 不读配置、不判去重、不发通知——那些是各业务 RPC 的事。
CREATE OR REPLACE FUNCTION billing.grant_bonus_credits(
  p_user_id UUID,
  p_credits NUMERIC,
  p_entry_type TEXT,
  p_reference_type TEXT,
  p_reference_id TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  OUT o_ledger_id UUID,
  OUT o_wallet billing.user_wallets
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  IF p_user_id IS NULL OR p_credits IS NULL OR p_credits <= 0 THEN
    RAISE EXCEPTION 'grant_bonus_credits: credits must be positive (user=%, credits=%)', p_user_id, p_credits
      USING ERRCODE = '22023';
  END IF;
  IF p_entry_type IS NULL OR p_reference_type IS NULL THEN
    RAISE EXCEPTION 'grant_bonus_credits: entry_type and reference_type are required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE billing.user_wallets
  SET
    bonus_credits = billing.user_wallets.bonus_credits + p_credits,
    updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO o_wallet;

  INSERT INTO billing.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta,
    balance_main, balance_bonus, reference_type, reference_id, metadata
  ) VALUES (
    p_user_id, p_entry_type, p_credits, 0, p_credits,
    o_wallet.main_credits, o_wallet.bonus_credits, p_reference_type, p_reference_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO o_ledger_id;
END;
$$;

REVOKE ALL ON FUNCTION billing.grant_bonus_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.grant_bonus_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO service_role, postgres;

COMMENT ON FUNCTION billing.grant_bonus_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB) IS
  '奖励发放唯一入口：钱包 upsert + bonus_credits 加值 + wallet_ledger 记账。各发奖 RPC 只准调它，不准自己 UPDATE user_wallets（legacy guard wallet-bonus-grant）。';

-- ── 2. 签到（019 / 031 → 099 搬到 miniapp_features）──────────────────────
CREATE OR REPLACE FUNCTION miniapp_features.claim_daily_checkin(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_last_claimed_at TIMESTAMPTZ;
  v_reward INTEGER;
  v_ledger_id UUID;
  v_grant RECORD;
  v_claimed_at TIMESTAMPTZ := now();
BEGIN
  SELECT claimed_at
  INTO v_last_claimed_at
  FROM miniapp_features.daily_checkins
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
        (SELECT NULLIF(value #>> '{}', '')::numeric FROM app_core.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits'),
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

  -- 原先 updated_at = v_claimed_at；v_claimed_at := now() 在同一事务内与 now() 恒等，语义不变。
  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id, v_reward, 'checkin_bonus', 'daily_checkin', p_user_id::text,
    jsonb_build_object('claimed_at', v_claimed_at)
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  INSERT INTO miniapp_features.daily_checkins (
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

-- ── 3. 许愿（021 / 086 → 099）────────────────────────────────────────────
CREATE OR REPLACE FUNCTION miniapp_features.create_wish_role(p_db_user_id uuid, p_telegram_user_id bigint, p_wish_text text, p_reward_credits integer DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_trimmed TEXT := trim(p_wish_text);
  v_wallet billing.user_wallets;
  v_wish miniapp_features.wish_roles;
  v_ledger_id UUID;
  v_grant RECORD;
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
    FROM miniapp_features.wish_roles
    WHERE user_id = p_telegram_user_id
      AND created_at > v_now - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'wish limit reached: %', p_telegram_user_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 仍要先锁钱包行：wish_roles.total_paid_amount_at_submit 取的是发奖前的快照。
  INSERT INTO billing.user_wallets (user_id)
  VALUES (p_db_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = p_db_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found: %', p_db_user_id
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO miniapp_features.wish_roles (
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

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_db_user_id, p_reward_credits, 'wish_reward', 'wish_role', v_wish.id::text,
    jsonb_build_object(
      'telegram_user_id', p_telegram_user_id,
      'wish_text_length', char_length(v_trimmed)
    )
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  RETURN jsonb_build_object(
    'wish', to_jsonb(v_wish),
    'wallet', to_jsonb(v_wallet),
    'wallet_ledger_id', v_ledger_id
  );
END;
$$;

-- ── 4. 注册奖励（031 → 099；由 app_core.users 插入触发器调用）─────────────
CREATE OR REPLACE FUNCTION billing.grant_new_user_signup_bonus(p_user_id uuid)
RETURNS billing.user_wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = billing, public
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_bonus INTEGER;
  v_ledger_id UUID;
  v_grant RECORD;
BEGIN
  SELECT COALESCE(
    floor(
      COALESCE(
        (
          SELECT NULLIF(value #>> '{}', '')::numeric
          FROM app_core.runtime_config
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

  -- 仍要先锁钱包行：下面的幂等判定要在行锁内做。
  INSERT INTO billing.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM billing.wallet_ledger
    WHERE user_id = p_user_id
      AND entry_type = 'adjustment'
      AND metadata ->> 'reason' = 'signup_bonus'
  ) THEN
    RETURN v_wallet;
  END IF;

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id, v_bonus, 'adjustment', 'signup_bonus', p_user_id::text,
    jsonb_build_object('reason', 'signup_bonus')
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  RETURN v_wallet;
END;
$$;

-- ── 5. 运营赠送（066）────────────────────────────────────────────────────
-- 原顺序：加余额 → 发通知 → 记流水（流水 metadata 要带 notification_id）。
-- 现在加余额与记流水合成一步，因此先发通知再调 grant_bonus_credits；同一事务内终值不变。
CREATE OR REPLACE FUNCTION admin.grant_user_credits(p_user_id uuid, p_amount integer, p_title text, p_body text, p_request_id uuid, p_allow_duplicate boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_existing billing.wallet_ledger%ROWTYPE;
  v_recent billing.wallet_ledger%ROWTYPE;
  v_notification miniapp_features.notifications%ROWTYPE;
  v_ledger_id UUID;
  v_grant RECORD;
  v_title TEXT := trim(COALESCE(p_title, ''));
  v_body TEXT := trim(COALESCE(p_body, ''));
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'grant request id is required' USING ERRCODE = '22023';
  END IF;
  -- 上限只是防手滑的硬闸，运营侧的额度规则本次不做。
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000 THEN
    RAISE EXCEPTION 'grant amount must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_title) < 1 OR char_length(v_title) > 120 THEN
    RAISE EXCEPTION 'notification title must be 1-120 chars' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) < 1 OR char_length(v_body) > 4000 THEN
    RAISE EXCEPTION 'notification body must be 1-4000 chars' USING ERRCODE = '22023';
  END IF;

  SELECT ledger.* INTO v_existing
  FROM billing.wallet_ledger AS ledger
  WHERE ledger.reference_type = 'outreach_grant'
    AND ledger.reference_id = p_request_id::TEXT;
  IF FOUND THEN
    SELECT wallet.* INTO v_wallet
    FROM billing.user_wallets AS wallet
    WHERE wallet.user_id = v_existing.user_id;
    RETURN jsonb_build_object(
      'granted', false,
      'blocked', false,
      'user_id', v_existing.user_id,
      'amount', v_existing.amount,
      'main_credits', v_wallet.main_credits,
      'bonus_credits', v_wallet.bonus_credits,
      'total_credits', v_wallet.total_credits,
      'notification_id', v_existing.metadata ->> 'notification_id',
      'granted_at', v_existing.created_at
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_core.users AS app_user WHERE app_user.id = p_user_id) THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  -- request id 只能挡住「同一次操作」的重试。换台机器、换个浏览器重来会带新的 id，
  -- 所以这里再按「同一人同一金额」加一道短时窗软拦截：不报错，回一个待确认状态，
  -- 由客服显式放行。PRD 允许短时间内重复赠送，因此只能软拦不能硬禁。
  IF NOT COALESCE(p_allow_duplicate, false) THEN
    SELECT ledger.* INTO v_recent
    FROM billing.wallet_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.reference_type = 'outreach_grant'
      AND ledger.amount = p_amount
      AND ledger.created_at > now() - interval '10 minutes'
    ORDER BY ledger.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'granted', false,
        'blocked', true,
        'reason', 'duplicate_window',
        'user_id', p_user_id,
        'amount', p_amount,
        'last_amount', v_recent.amount,
        'last_granted_at', v_recent.created_at
      );
    END IF;
  END IF;

  INSERT INTO billing.user_wallets (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT wallet.* INTO v_wallet
  FROM billing.user_wallets AS wallet
  WHERE wallet.user_id = p_user_id
  FOR UPDATE;

  INSERT INTO miniapp_features.notifications (
    scope, category, title, body, user_id, is_published, published_at, created_by
  ) VALUES (
    'official', 'activity', v_title, v_body, p_user_id, true, now(), v_actor.user_id
  ) RETURNING * INTO v_notification;

  -- 与新用户赠送、签到、许愿奖励一致，运营赠送只加 bonus_credits。
  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id, p_amount, 'adjustment', 'outreach_grant', p_request_id::TEXT,
    jsonb_build_object(
      'reason', 'outreach_grant',
      'notification_id', v_notification.id,
      'actor_user_id', v_actor.user_id,
      'actor_email', v_actor.email
    )
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'wallet.outreach_grant', 'billing', 'user_wallets', p_user_id::TEXT,
    NULL,
    jsonb_build_object(
      'amount', p_amount,
      'request_id', p_request_id,
      'notification_id', v_notification.id,
      'balance_bonus', v_wallet.bonus_credits
    )
  );

  RETURN jsonb_build_object(
    'granted', true,
    'blocked', false,
    'user_id', p_user_id,
    'amount', p_amount,
    'main_credits', v_wallet.main_credits,
    'bonus_credits', v_wallet.bonus_credits,
    'total_credits', v_wallet.total_credits,
    'notification_id', v_notification.id,
    'granted_at', v_notification.published_at
  );
END;
$$;

-- ── 6. 邀请奖励（105）───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION miniapp_traffic.grant_invite_reward(p_relation_id uuid, p_rule_key text, p_event_ref text)
RETURNS TABLE(status text, credits integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_inviter UUID;
  v_cfg JSONB;
  v_rule JSONB;
  v_cap INTEGER;
  v_credits INTEGER;
  v_granted INTEGER;
  v_log_id UUID;
  v_ledger_id UUID;
  v_grant RECORD;
  v_wallet billing.user_wallets%ROWTYPE;
BEGIN
  -- 锁关系行：串行化同一关系的并发发奖，保证上限校验不被并发穿透。
  SELECT r.inviter_user_id INTO v_inviter
  FROM miniapp_traffic.invite_relations AS r
  WHERE r.id = p_relation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant_invite_reward: 邀请关系 % 不存在', p_relation_id
      USING ERRCODE = '22023';
  END IF;

  SELECT rc.value INTO v_cfg
  FROM app_core.runtime_config AS rc
  WHERE rc.key = 'miniapp_invite_reward_rules';

  IF v_cfg IS NULL THEN
    RETURN QUERY SELECT 'skipped'::TEXT, 0;
    RETURN;
  END IF;

  SELECT r.rule INTO v_rule
  FROM jsonb_array_elements(COALESCE(v_cfg -> 'rules', '[]'::jsonb)) AS r(rule)
  WHERE r.rule ->> 'rule_key' = p_rule_key;

  IF v_rule IS NULL
     OR COALESCE((v_rule ->> 'enabled')::boolean, FALSE) IS NOT TRUE
     OR COALESCE((v_rule ->> 'credits')::integer, 0) <= 0 THEN
    RETURN QUERY SELECT 'skipped'::TEXT, 0;
    RETURN;
  END IF;

  v_credits := (v_rule ->> 'credits')::integer;
  v_cap := COALESCE((v_cfg ->> 'total_cap_credits')::integer, 2200);

  SELECT COALESCE(SUM(l.credits), 0)::integer INTO v_granted
  FROM miniapp_traffic.invite_reward_logs AS l
  WHERE l.relation_id = p_relation_id;

  IF v_granted >= v_cap THEN
    RETURN QUERY SELECT 'cap_reached'::TEXT, 0;
    RETURN;
  END IF;
  -- 触及上限时截断本次金额，保证单关系累计恰好不超过 cap。
  v_credits := LEAST(v_credits, v_cap - v_granted);

  INSERT INTO miniapp_traffic.invite_reward_logs (
    relation_id, inviter_user_id, rule_key, event_ref, credits
  ) VALUES (
    p_relation_id, v_inviter, p_rule_key, p_event_ref, v_credits
  )
  ON CONFLICT ON CONSTRAINT invite_reward_dedup DO NOTHING
  RETURNING id INTO v_log_id;

  IF v_log_id IS NULL THEN
    -- 幂等出口：同一 (关系, 规则, 事件) 重放到此为止，账务零变化。
    RETURN QUERY SELECT 'duplicated'::TEXT, 0;
    RETURN;
  END IF;

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    v_inviter, v_credits, 'invite_reward', 'invite_reward', v_log_id::text,
    jsonb_build_object(
      'relation_id', p_relation_id,
      'rule_key', p_rule_key,
      'event_ref', p_event_ref
    )
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  RETURN QUERY SELECT 'granted'::TEXT, v_credits;
END;
$$;

-- ── 7. 社群入群奖励（108 建 / 109 替换；本迁移基于 109 版本）──────────────
CREATE OR REPLACE FUNCTION miniapp_features.grant_community_join_reward(p_user_id uuid, p_telegram_user_id text, p_community_chat_id text, p_reward_credits integer, p_telegram_update_id bigint)
RETURNS TABLE(status text, credits integer, granted_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_claim_id UUID;
  v_granted_at TIMESTAMPTZ;
  v_wallet billing.user_wallets%ROWTYPE;
  v_ledger_id UUID;
  v_grant RECORD;
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

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id, v_config_credits, 'community_reward', 'community_join', v_claim_id::TEXT,
    jsonb_build_object('community_chat_id', p_community_chat_id, 'telegram_update_id', p_telegram_update_id,
      'claim_method', CASE WHEN p_telegram_update_id IS NULL THEN 'existing_member_verification' ELSE 'join_webhook' END)
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

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

COMMIT;
