-- 108: 裂变邀请奖励规则收紧为「被邀请人完成 N 轮文本对话」。
-- domain: acquisition（miniapp_traffic，承接 105/106/107）
--
-- 背景：原规则 invitee_registered 在绑定成功时立即给邀请人发 200 星尘；
-- 本迁移保留旧 rule_key 但停用，新增 invitee_chat_rounds，并把阈值
-- threshold_rounds 放进 managed config，默认 3。
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。

BEGIN;

-- ─── 0. 前置守卫 ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('miniapp_traffic.invite_relations') IS NULL
     OR to_regclass('miniapp_traffic.invite_reward_logs') IS NULL
     OR to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL THEN
    RAISE EXCEPTION '缺少裂变邀请 105 迁移产物，请先执行 105_invite_program.sql';
  END IF;
  IF to_regprocedure('miniapp_traffic.grant_invite_reward(uuid,text,text)') IS NULL
     OR to_regprocedure('miniapp_traffic.bind_invite(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '缺少裂变邀请 RPC，请先执行 105_invite_program.sql';
  END IF;
END;
$$;

-- ─── 1. config 校验：允许奖励规则携带可选 threshold_rounds ───────────────────
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
  v_threshold NUMERIC;
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
    IF v_rule ? 'threshold_rounds' THEN
      IF jsonb_typeof(v_rule -> 'threshold_rounds') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'rule % threshold_rounds must be a positive integer', v_key
          USING ERRCODE = '22023';
      END IF;
      v_threshold := (v_rule ->> 'threshold_rounds')::numeric;
      IF v_threshold <= 0 OR v_threshold <> floor(v_threshold) THEN
        RAISE EXCEPTION 'rule % threshold_rounds must be a positive integer', v_key
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION admin.validate_invite_reward_rules(JSONB) IS
  'Validate invite reward rules: positive integer cap, unique non-empty rule keys, positive integer credits, boolean enabled, optional positive integer threshold_rounds.';

-- ─── 2. 运行时规则迁移：注册规则停用，新增 3 轮文本对话规则 ─────────────────
DO $$
DECLARE
  v_cfg JSONB;
  v_registered JSONB;
  v_chat JSONB;
  v_others JSONB;
  v_registered_credits INTEGER;
  v_next JSONB;
BEGIN
  SELECT value INTO v_cfg
  FROM app_core.runtime_config
  WHERE key = 'miniapp_invite_reward_rules'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'miniapp_invite_reward_rules 不存在，请先执行 105_invite_program.sql';
  END IF;

  SELECT r.rule INTO v_registered
  FROM jsonb_array_elements(COALESCE(v_cfg -> 'rules', '[]'::jsonb)) AS r(rule)
  WHERE r.rule ->> 'rule_key' = 'invitee_registered';

  SELECT r.rule INTO v_chat
  FROM jsonb_array_elements(COALESCE(v_cfg -> 'rules', '[]'::jsonb)) AS r(rule)
  WHERE r.rule ->> 'rule_key' = 'invitee_chat_rounds';

  SELECT COALESCE(jsonb_agg(r.rule), '[]'::jsonb) INTO v_others
  FROM jsonb_array_elements(COALESCE(v_cfg -> 'rules', '[]'::jsonb)) AS r(rule)
  WHERE COALESCE(r.rule ->> 'rule_key', '') NOT IN ('invitee_registered', 'invitee_chat_rounds');

  v_registered_credits := COALESCE((v_registered ->> 'credits')::integer, 200);

  v_next := jsonb_build_object(
    'total_cap_credits', COALESCE(v_cfg -> 'total_cap_credits', '2200'::jsonb),
    'rules',
      jsonb_build_array(
        jsonb_build_object(
          'rule_key', 'invitee_registered',
          'credits', v_registered_credits,
          'enabled', false
        ),
        jsonb_build_object(
          'rule_key', 'invitee_chat_rounds',
          'credits', COALESCE((v_chat ->> 'credits')::integer, v_registered_credits, 200),
          'enabled', COALESCE((v_chat ->> 'enabled')::boolean, true),
          'threshold_rounds', COALESCE((v_chat ->> 'threshold_rounds')::integer, 3)
        )
      ) || v_others
  );

  PERFORM admin.validate_invite_reward_rules(v_next);

  UPDATE app_core.runtime_config
  SET
    value = v_next,
    description = '裂变邀请奖励规则：invitee_registered 保留但停用；invitee_chat_rounds 在被邀请人累计文本对话轮次达到 threshold_rounds 后发放。total_cap_credits 为单个下级用户累计奖励上限。',
    version = version + 1,
    updated_at = now()
  WHERE key = 'miniapp_invite_reward_rules';
END;
$$;

-- ─── 3. RPC：检查被邀请人文本对话轮次并幂等发奖 ─────────────────────────────
CREATE OR REPLACE FUNCTION miniapp_traffic.check_invite_chat_rounds_reward(
  p_invitee_user_id UUID
) RETURNS TABLE (status TEXT, credits INTEGER, total_round BIGINT, threshold_rounds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_relation miniapp_traffic.invite_relations%ROWTYPE;
  v_cfg JSONB;
  v_rule JSONB;
  v_total_round BIGINT;
  v_threshold INTEGER;
  v_already_granted BOOLEAN;
  v_grant RECORD;
BEGIN
  SELECT r.* INTO v_relation
  FROM miniapp_traffic.invite_relations AS r
  WHERE r.invitee_user_id = p_invitee_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_relation'::TEXT, 0, 0::BIGINT, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT COALESCE(u.total_round, 0) INTO v_total_round
  FROM app_core.users AS u
  WHERE u.id = p_invitee_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'check_invite_chat_rounds_reward: 被邀请用户 % 不存在', p_invitee_user_id
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM miniapp_traffic.invite_reward_logs AS l
    WHERE l.relation_id = v_relation.id
      -- 108 上线前已经按注册规则发过 200 的历史关系，不能在达标后再补发一次。
      AND l.rule_key IN ('invitee_registered', 'invitee_chat_rounds')
      AND l.event_ref = p_invitee_user_id::text
  ) INTO v_already_granted;

  IF v_already_granted THEN
    RETURN QUERY SELECT 'duplicated'::TEXT, 0, v_total_round, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT rc.value INTO v_cfg
  FROM app_core.runtime_config AS rc
  WHERE rc.key = 'miniapp_invite_reward_rules';

  SELECT r.rule INTO v_rule
  FROM jsonb_array_elements(COALESCE(v_cfg -> 'rules', '[]'::jsonb)) AS r(rule)
  WHERE r.rule ->> 'rule_key' = 'invitee_chat_rounds';

  IF v_rule IS NULL
     OR COALESCE((v_rule ->> 'enabled')::boolean, FALSE) IS NOT TRUE
     OR COALESCE((v_rule ->> 'credits')::integer, 0) <= 0 THEN
    RETURN QUERY SELECT 'skipped'::TEXT, 0, v_total_round, NULL::INTEGER;
    RETURN;
  END IF;

  v_threshold := COALESCE((v_rule ->> 'threshold_rounds')::integer, 3);

  IF v_total_round < v_threshold THEN
    RETURN QUERY SELECT 'below_threshold'::TEXT, 0, v_total_round, v_threshold;
    RETURN;
  END IF;

  SELECT * INTO v_grant
  FROM miniapp_traffic.grant_invite_reward(
    v_relation.id,
    'invitee_chat_rounds',
    p_invitee_user_id::text
  );

  RETURN QUERY SELECT v_grant.status::TEXT, v_grant.credits::INTEGER, v_total_round, v_threshold;
END;
$$;

COMMENT ON FUNCTION miniapp_traffic.check_invite_chat_rounds_reward(UUID) IS
  '检查被邀请人的 total_round 是否达到 invitee_chat_rounds.threshold_rounds，达标后复用 grant_invite_reward 幂等发奖；历史 invitee_registered 流水视为已发过。';

-- ─── 4. RPC：绑定关系后只做达标检查，不再注册即发 ─────────────────────────
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

  -- 绑定只建立归因关系；若用户在绑定补报前已满足轮次阈值，这里补做一次达标检查。
  PERFORM miniapp_traffic.check_invite_chat_rounds_reward(p_invitee_user_id);

  RETURN QUERY SELECT 'bound'::TEXT, v_inviter, v_relation_id;
END;
$$;

COMMENT ON FUNCTION miniapp_traffic.bind_invite(UUID, TEXT) IS
  '绑定邀请关系；不再注册即发奖，仅在绑定补报时调用 invitee_chat_rounds 达标检查。除 invalid_code 外所有返回状态均为幂等终态。';

-- ─── 5. RPC 权限 ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION miniapp_traffic.check_invite_chat_rounds_reward(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_traffic.check_invite_chat_rounds_reward(UUID)
  TO service_role, postgres;

-- ─── 6. 自检 ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cfg JSONB;
  v_registered JSONB;
  v_chat JSONB;
  v_raised BOOLEAN;
BEGIN
  SELECT value INTO v_cfg
  FROM app_core.runtime_config
  WHERE key = 'miniapp_invite_reward_rules';

  SELECT r.rule INTO v_registered
  FROM jsonb_array_elements(v_cfg -> 'rules') AS r(rule)
  WHERE r.rule ->> 'rule_key' = 'invitee_registered';

  SELECT r.rule INTO v_chat
  FROM jsonb_array_elements(v_cfg -> 'rules') AS r(rule)
  WHERE r.rule ->> 'rule_key' = 'invitee_chat_rounds';

  IF COALESCE((v_registered ->> 'enabled')::boolean, TRUE) IS NOT FALSE THEN
    RAISE EXCEPTION '108 自检失败：invitee_registered 未停用';
  END IF;
  IF v_chat IS NULL
     OR COALESCE((v_chat ->> 'enabled')::boolean, FALSE) IS NOT TRUE
     OR COALESCE((v_chat ->> 'threshold_rounds')::integer, 0) <> 3 THEN
    RAISE EXCEPTION '108 自检失败：invitee_chat_rounds 未按默认 3 轮启用 -> %', v_chat;
  END IF;
  IF to_regprocedure('miniapp_traffic.check_invite_chat_rounds_reward(uuid)') IS NULL THEN
    RAISE EXCEPTION '108 自检失败：check_invite_chat_rounds_reward RPC 缺失';
  END IF;

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_invite_reward_rules(
      jsonb_build_object(
        'total_cap_credits', 2200,
        'rules', jsonb_build_array(
          jsonb_build_object(
            'rule_key', 'invitee_chat_rounds',
            'credits', 200,
            'enabled', true,
            'threshold_rounds', 0
          )
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '108 自检失败：threshold_rounds=0 未被拒绝';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
