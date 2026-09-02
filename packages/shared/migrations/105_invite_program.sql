-- 105: 裂变邀请（invite program）阶段一：表结构、账务扩展、RPC 与运营配置。
-- domain: acquisition（miniapp_traffic，见 docs/schema归属地图.md）
--
-- 设计依据：docs/裂变工程落地实施方案.md + docs/裂变阶段一实施计划.md
--
-- 内容：
--   1. miniapp_traffic 三张表：invite_codes / invite_relations / invite_reward_logs
--   2. billing.wallet_ledger 的 entry_type CHECK 扩展 'invite_reward'
--   3. RPC：ensure_invite_code / bind_invite / grant_invite_reward（均 SECURITY DEFINER）
--   4. app_core.runtime_config 三个新 key + admin managed-config 白名单四件套
--
-- 白名单基线说明：test 库经 104、prod 库经 095 后收敛到同一份 14-key 列表；
-- 本文件在该基线上追加 3 个 invite key，整段重建四件套并在尾部自检
--（095 教训：并行迁移会互相覆盖整段声明，重建时必须带全既有 key）。
--
-- 前置：099 已执行（app_core / billing / miniapp_traffic schema 存在）。
-- 执行：GitHub Actions → Database Migration，先 test 后 production。

BEGIN;

-- ─── 0. 前置守卫 ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('billing.wallet_ledger') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL THEN
    RAISE EXCEPTION '缺少 099 之后的 schema 布局（app_core / billing），请先执行 099';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'miniapp_traffic'
  ) THEN
    RAISE EXCEPTION '缺少 miniapp_traffic schema';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_managed_config_value_before_payment_prompt，白名单基线不是 095/104，请先核对';
  END IF;
END;
$$;

-- ─── 1. 邀请码表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp_traffic.invite_codes (
  user_id                 UUID PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  code                    TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8}$'),
  center_first_entered_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE miniapp_traffic.invite_codes IS
  '裂变邀请：用户专属邀请码（对用户永久固定，首次进入邀请中心时懒生成）。';
COMMENT ON COLUMN miniapp_traffic.invite_codes.center_first_entered_at IS
  '首次进入邀请中心时间；为 NULL 时 C 端"我的"页展示 2200 星尘提醒标签。';

-- ─── 2. 邀请关系表（归因唯一性核心） ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp_traffic.invite_relations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id  UUID NOT NULL REFERENCES app_core.users(id),
  invitee_user_id  UUID NOT NULL UNIQUE REFERENCES app_core.users(id),
  invite_code      TEXT NOT NULL,
  bound_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invite_no_self CHECK (inviter_user_id <> invitee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_invite_relations_inviter
  ON miniapp_traffic.invite_relations (inviter_user_id, bound_at DESC);

COMMENT ON TABLE miniapp_traffic.invite_relations IS
  '裂变邀请：邀请人-下级用户关系。invitee 唯一索引兜底"一人只绑一次、不可覆盖"。';

-- ─── 3. 发奖流水表（幂等核心） ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp_traffic.invite_reward_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id      UUID NOT NULL REFERENCES miniapp_traffic.invite_relations(id),
  inviter_user_id  UUID NOT NULL,
  rule_key         TEXT NOT NULL,
  event_ref        TEXT NOT NULL,
  credits          INTEGER NOT NULL CHECK (credits > 0),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invite_reward_dedup UNIQUE (relation_id, rule_key, event_ref)
);

CREATE INDEX IF NOT EXISTS idx_invite_reward_inviter
  ON miniapp_traffic.invite_reward_logs (inviter_user_id, granted_at DESC);

COMMENT ON TABLE miniapp_traffic.invite_reward_logs IS
  '裂变邀请：发奖业务明细。(relation_id, rule_key, event_ref) 唯一键吸收一切事件重放；星尘到账本体在 billing.wallet_ledger。';

-- ─── 4. RLS 与表权限（对齐 016 模式） ────────────────────────────────────────
ALTER TABLE miniapp_traffic.invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_traffic.invite_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_traffic.invite_reward_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_traffic.invite_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON miniapp_traffic.invite_relations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON miniapp_traffic.invite_reward_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp_traffic.invite_codes TO service_role, postgres;
GRANT ALL ON miniapp_traffic.invite_relations TO service_role, postgres;
GRANT ALL ON miniapp_traffic.invite_reward_logs TO service_role, postgres;

-- ─── 5. 账务：entry_type CHECK 扩展（沿用 021/086 加 wish_reward 的先例） ────
ALTER TABLE billing.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN (
    'recharge', 'chat_debit', 'refund', 'adjustment',
    'checkin_bonus', 'wish_reward', 'invite_reward'
  ));

-- ─── 6. RPC：懒生成邀请码 + 标记首次进入邀请中心 ─────────────────────────────
CREATE OR REPLACE FUNCTION miniapp_traffic.ensure_invite_code(
  p_user_id UUID
) RETURNS TABLE (code TEXT, first_visit BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing miniapp_traffic.invite_codes%ROWTYPE;
  v_code TEXT;
  v_attempt INTEGER := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 5 THEN
      RAISE EXCEPTION 'ensure_invite_code: 分配邀请码重试超限（user %）', p_user_id;
    END IF;

    -- 8 位大写十六进制短码，与 Telegram startapp 允许字符集兼容。
    v_code := upper(substr(md5(gen_random_uuid()::text), 1, 8));
    BEGIN
      INSERT INTO miniapp_traffic.invite_codes (user_id, code, center_first_entered_at)
      VALUES (p_user_id, v_code, now());
      RETURN QUERY SELECT v_code, TRUE;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_existing
      FROM miniapp_traffic.invite_codes
      WHERE user_id = p_user_id;

      IF FOUND THEN
        -- 用户已有码：必要时补记首次进入时间（并发下由 IS NULL 守卫保证只记一次）。
        IF v_existing.center_first_entered_at IS NULL THEN
          UPDATE miniapp_traffic.invite_codes
          SET center_first_entered_at = now()
          WHERE user_id = p_user_id
            AND center_first_entered_at IS NULL;
          RETURN QUERY SELECT v_existing.code, TRUE;
        ELSE
          RETURN QUERY SELECT v_existing.code, FALSE;
        END IF;
        RETURN;
      END IF;
      -- 码撞车（非 user_id 冲突）：换码重试。
    END;
  END LOOP;
END;
$$;

-- ─── 7. RPC：发奖（幂等 + 单关系累计上限） ───────────────────────────────────
CREATE OR REPLACE FUNCTION miniapp_traffic.grant_invite_reward(
  p_relation_id UUID,
  p_rule_key TEXT,
  p_event_ref TEXT
) RETURNS TABLE (status TEXT, credits INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_inviter UUID;
  v_cfg JSONB;
  v_rule JSONB;
  v_cap INTEGER;
  v_credits INTEGER;
  v_granted INTEGER;
  v_log_id UUID;
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

  INSERT INTO billing.user_wallets (user_id)
  VALUES (v_inviter)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE billing.user_wallets
  SET
    bonus_credits = billing.user_wallets.bonus_credits + v_credits,
    updated_at = now()
  WHERE user_id = v_inviter
  RETURNING * INTO v_wallet;

  INSERT INTO billing.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta,
    balance_main, balance_bonus, reference_type, reference_id, metadata
  ) VALUES (
    v_inviter, 'invite_reward', v_credits, 0, v_credits,
    v_wallet.main_credits, v_wallet.bonus_credits,
    'invite_reward', v_log_id::text,
    jsonb_build_object(
      'relation_id', p_relation_id,
      'rule_key', p_rule_key,
      'event_ref', p_event_ref
    )
  );

  RETURN QUERY SELECT 'granted'::TEXT, v_credits;
END;
$$;

-- ─── 8. RPC：绑定邀请关系（归因唯一 + 内联发奖，单事务） ─────────────────────
CREATE OR REPLACE FUNCTION miniapp_traffic.bind_invite(
  p_invitee_user_id UUID,
  p_invite_code TEXT
) RETURNS TABLE (status TEXT, inviter_user_id UUID, relation_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  -- "新用户"判定窗：users.created_at 距今超过该值视为已有账户，不建立关系。
  -- 窗口用于吸收首次打开时多个鉴权请求并发建号与绑定上报之间的时差（详见阶段一计划 D4）。
  v_new_user_window CONSTANT INTERVAL := INTERVAL '30 minutes';
  v_inviter UUID;
  v_created TIMESTAMPTZ;
  v_relation_id UUID;
  v_existing_inviter UUID;
  v_existing_id UUID;
BEGIN
  SELECT c.user_id INTO v_inviter
  FROM miniapp_traffic.invite_codes AS c
  WHERE c.code = upper(trim(p_invite_code));

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_code'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_inviter = p_invitee_user_id THEN
    RETURN QUERY SELECT 'self_invite'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  SELECT r.inviter_user_id, r.id INTO v_existing_inviter, v_existing_id
  FROM miniapp_traffic.invite_relations AS r
  WHERE r.invitee_user_id = p_invitee_user_id;

  IF FOUND THEN
    RETURN QUERY SELECT 'already_bound'::TEXT, v_existing_inviter, v_existing_id;
    RETURN;
  END IF;

  SELECT u.created_at INTO v_created
  FROM app_core.users AS u
  WHERE u.id = p_invitee_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_invite: 被邀请用户 % 不存在', p_invitee_user_id
      USING ERRCODE = '22023';
  END IF;

  IF v_created < now() - v_new_user_window THEN
    RETURN QUERY SELECT 'not_new_user'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO miniapp_traffic.invite_relations (
    inviter_user_id, invitee_user_id, invite_code
  ) VALUES (
    v_inviter, p_invitee_user_id, upper(trim(p_invite_code))
  )
  ON CONFLICT (invitee_user_id) DO NOTHING
  RETURNING id INTO v_relation_id;

  IF v_relation_id IS NULL THEN
    -- 并发下另一请求先完成绑定：回读并按已绑定返回。
    SELECT r.inviter_user_id, r.id INTO v_existing_inviter, v_existing_id
    FROM miniapp_traffic.invite_relations AS r
    WHERE r.invitee_user_id = p_invitee_user_id;
    RETURN QUERY SELECT 'already_bound'::TEXT, v_existing_inviter, v_existing_id;
    RETURN;
  END IF;

  -- 注册即发奖（已拍板 D2）：与绑定同事务，规则未启用时自动 skipped。
  PERFORM miniapp_traffic.grant_invite_reward(
    v_relation_id, 'invitee_registered', p_invitee_user_id::text
  );

  RETURN QUERY SELECT 'bound'::TEXT, v_inviter, v_relation_id;
END;
$$;

-- ─── 9. RPC 权限 ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION miniapp_traffic.ensure_invite_code(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp_traffic.grant_invite_reward(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp_traffic.bind_invite(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_traffic.ensure_invite_code(UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp_traffic.grant_invite_reward(UUID, TEXT, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp_traffic.bind_invite(UUID, TEXT) TO service_role, postgres;

COMMENT ON FUNCTION miniapp_traffic.ensure_invite_code(UUID) IS
  '懒生成用户专属邀请码并标记首次进入邀请中心；返回 (code, first_visit)。';
COMMENT ON FUNCTION miniapp_traffic.grant_invite_reward(UUID, TEXT, TEXT) IS
  '幂等发放邀请奖励：读已发布规则、校验单关系累计上限、写发奖明细与钱包流水（entry_type=invite_reward）。';
COMMENT ON FUNCTION miniapp_traffic.bind_invite(UUID, TEXT) IS
  '绑定邀请关系并内联发放注册奖励。除 invalid_code 外所有返回状态均为幂等终态。';

-- ─── 10. 运营配置 seed（新 key 不覆盖已有值） ────────────────────────────────
INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
VALUES (
  'miniapp_invite_reward_rules',
  '{
    "total_cap_credits": 2200,
    "rules": [
      { "rule_key": "invitee_registered", "credits": 200, "enabled": true },
      { "rule_key": "invitee_first_paid", "credits": 2000, "enabled": false }
    ]
  }'::jsonb,
  '裂变邀请奖励规则：total_cap_credits 为单个下级用户累计上限；rule_key 发布后不可改名（发奖流水引用它做幂等键），金额与开关运营可随时调整。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
VALUES (
  'miniapp_invite_center_config',
  '{
    "poster_url": "",
    "copy_templates": [
      "我在这里发现了超多有趣的角色，快来和我一起聊！点击专属链接注册，我们都能拿星尘奖励：{link}"
    ]
  }'::jsonb,
  '裂变邀请中心素材：poster_url 为已发布海报图（2160×3840）；copy_templates 为已发布文案库（C 端刷新按钮轮换来源），{link} 会被替换为用户专属链接。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
VALUES (
  'miniapp_invite_entry_enabled',
  'false'::jsonb,
  '裂变邀请入口总开关：false 时 C 端隐藏邀请中心全部入口。生产环境先关后开，代码上线不等于功能上线。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- ─── 11. 新 key 的结构校验函数 ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin.validate_invite_reward_rules(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_rule JSONB;
  v_seen TEXT[] := ARRAY[]::TEXT[];
  v_key TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'miniapp_invite_reward_rules must be an object'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE((p_value ->> 'total_cap_credits')::numeric, 0) <= 0
     OR (p_value ->> 'total_cap_credits')::numeric <> floor((p_value ->> 'total_cap_credits')::numeric) THEN
    RAISE EXCEPTION 'total_cap_credits must be a positive integer'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rules must be an array'
      USING ERRCODE = '22023';
  END IF;

  FOR v_rule IN SELECT jsonb_array_elements(p_value -> 'rules') LOOP
    v_key := trim(COALESCE(v_rule ->> 'rule_key', ''));
    IF v_key = '' OR char_length(v_key) > 64 THEN
      RAISE EXCEPTION 'rule_key must be a non-empty string within 64 chars'
        USING ERRCODE = '22023';
    END IF;
    IF v_key = ANY (v_seen) THEN
      RAISE EXCEPTION 'duplicated rule_key: %', v_key
        USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_key;
    IF COALESCE((v_rule ->> 'credits')::numeric, 0) <= 0
       OR (v_rule ->> 'credits')::numeric <> floor((v_rule ->> 'credits')::numeric) THEN
      RAISE EXCEPTION 'rule % credits must be a positive integer', v_key
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_rule -> 'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'rule % enabled must be a boolean', v_key
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_invite_center_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_template JSONB;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'miniapp_invite_center_config must be an object'
      USING ERRCODE = '22023';
  END IF;
  -- poster_url 允许为空串（海报未发布时 C 端降级不展示），但必须是字符串。
  IF jsonb_typeof(p_value -> 'poster_url') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'poster_url must be a string'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'copy_templates') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_value -> 'copy_templates') < 1 THEN
    RAISE EXCEPTION 'copy_templates must be a non-empty array'
      USING ERRCODE = '22023';
  END IF;
  FOR v_template IN SELECT jsonb_array_elements(p_value -> 'copy_templates') LOOP
    IF jsonb_typeof(v_template) IS DISTINCT FROM 'string'
       OR COALESCE(char_length(trim(v_template #>> '{}')), 0) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'each copy template must be a non-empty string within 1000 chars'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION admin.validate_invite_reward_rules(JSONB) IS
  'Validate invite reward rules: positive integer cap, unique non-empty rule keys, positive integer credits, boolean enabled.';
COMMENT ON FUNCTION admin.validate_invite_center_config(JSONB) IS
  'Validate invite center material config: string poster_url plus a non-empty copy template array.';

-- ─── 12. 白名单四件套整段重建（基线 14 key + 本次 3 key） ────────────────────
ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
  ));

ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases
  ADD CONSTRAINT config_releases_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
  ));

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
  );
$$;

-- 校验总入口：在 095/104 版本（lobby / payment_prompt 两分支 + 下沉）之上加三个 invite 分支。
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_reward_rules must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_center_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_center_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a boolean'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_invite_reward_rules(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_invite_center_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 13. 自检：断言不成立就让本次迁移失败回滚 ────────────────────────────────
DO $$
DECLARE
  v_key TEXT;
  v_def TEXT;
  v_raised BOOLEAN;
BEGIN
  -- 1) 三个新 key 与既有 key 都应对运营台可见
  FOREACH v_key IN ARRAY ARRAY[
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled',
    'miniapp_payment_prompt_dialog_config',
    'lobby_pinned_characters'
  ] LOOP
    IF NOT admin.is_managed_config_key(v_key) THEN
      RAISE EXCEPTION '自检失败：is_managed_config_key(%) 返回 false', v_key;
    END IF;
  END LOOP;

  -- 2) 两处 CHECK 都应包含新 key 且保留既有 key
  FOR v_def IN
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
      AND conname LIKE '%config_key_check'
  LOOP
    IF position('miniapp_invite_reward_rules' IN v_def) = 0
       OR position('miniapp_invite_center_config' IN v_def) = 0
       OR position('miniapp_invite_entry_enabled' IN v_def) = 0 THEN
      RAISE EXCEPTION '自检失败：CHECK 缺少 invite key -> %', v_def;
    END IF;
    IF position('miniapp_payment_prompt_dialog_config' IN v_def) = 0
       OR position('lobby_pinned_characters' IN v_def) = 0 THEN
      RAISE EXCEPTION '自检失败：CHECK 丢失既有 key -> %', v_def;
    END IF;
  END LOOP;

  -- 3) 三个新 key 的校验分支应拒绝非法输入
  FOREACH v_key IN ARRAY ARRAY[
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
  ] LOOP
    v_raised := FALSE;
    BEGIN
      PERFORM admin.validate_managed_config_value(v_key, '{}'::jsonb, 'probe');
    EXCEPTION WHEN OTHERS THEN
      v_raised := TRUE;
      IF position('must not use text_value' IN SQLERRM) = 0 THEN
        RAISE EXCEPTION '自检失败：% 没走到自己的分支，实际报错为 %', v_key, SQLERRM;
      END IF;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION '自检失败：% 校验分支静默放过了非法输入', v_key;
    END IF;
  END LOOP;

  -- 4) 既有 key 校验链仍应接在 before_payment_prompt 快照上
  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：下沉校验链没接上（system_instructions 空值未被拒绝）';
  END IF;

  -- 5) entry_type CHECK 应包含 invite_reward 且保留既有类型
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid = 'billing.wallet_ledger'::regclass
    AND conname = 'wallet_ledger_entry_type_check';
  IF v_def IS NULL
     OR position('invite_reward' IN v_def) = 0
     OR position('wish_reward' IN v_def) = 0
     OR position('checkin_bonus' IN v_def) = 0 THEN
    RAISE EXCEPTION '自检失败：wallet_ledger entry_type CHECK 不完整 -> %', COALESCE(v_def, 'NULL');
  END IF;

  -- 6) 三张表与三个 RPC 应存在
  IF to_regclass('miniapp_traffic.invite_codes') IS NULL
     OR to_regclass('miniapp_traffic.invite_relations') IS NULL
     OR to_regclass('miniapp_traffic.invite_reward_logs') IS NULL THEN
    RAISE EXCEPTION '自检失败：invite 表缺失';
  END IF;
  IF to_regprocedure('miniapp_traffic.ensure_invite_code(uuid)') IS NULL
     OR to_regprocedure('miniapp_traffic.bind_invite(uuid,text)') IS NULL
     OR to_regprocedure('miniapp_traffic.grant_invite_reward(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '自检失败：invite RPC 缺失';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证（test 库执行后手动跑）：
--   SELECT * FROM miniapp_traffic.ensure_invite_code('<某测试用户 uuid>');           -- (8 位码, true)
--   SELECT * FROM miniapp_traffic.bind_invite('<新用户 uuid>', '<上面的码>');         -- bound
--   SELECT * FROM miniapp_traffic.bind_invite('<同一 uuid>', '<任意有效码>');         -- already_bound
--   SELECT * FROM miniapp_traffic.grant_invite_reward('<关系 id>', 'invitee_registered', '<新用户 uuid>');
--     -- duplicated（绑定时已发过）
--   SELECT admin.is_managed_config_key('miniapp_invite_reward_rules');                -- true
--   SELECT count(*) FROM billing.wallet_ledger WHERE entry_type = 'invite_reward';    -- ≥ 1
