-- 109: 裂变邀请奖励规则「被邀请人首次付费」接上代码挂点。
-- domain: acquisition（miniapp_traffic，承接 105/106/107/108）
--
-- 背景：105 seed 了 invitee_first_paid（2000 星尘，enabled=false），但发奖只有配置没有挂点，
-- 运营在 admin 把开关翻 true 也不会有人调 grant_invite_reward。本迁移补上判定 RPC，
-- 后端在支付入账唯一出口 PaymentSettlement.settlePaidOrder 调用它。
--
-- 本迁移不动 enabled：是否开始发奖由运营在 admin 发布配置决定。
--
-- 前置：105 已执行（本文件对 108 无逻辑依赖，但生产仍按序号顺序执行）；
--       payment_orders 已在 billing，即 099 已执行。
-- 执行：GitHub Actions → Database Migration，先 test 后 production。

BEGIN;

-- ─── 0. 前置守卫 ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('miniapp_traffic.invite_relations') IS NULL
     OR to_regclass('miniapp_traffic.invite_reward_logs') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL THEN
    RAISE EXCEPTION '缺少裂变邀请 105 迁移产物，请先执行 105_invite_program.sql';
  END IF;
  IF to_regprocedure('miniapp_traffic.grant_invite_reward(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 miniapp_traffic.grant_invite_reward，请先执行 105_invite_program.sql';
  END IF;
  -- 首付判定要数用户已入账的订单笔数，订单表必须已随 099 落到 billing。
  IF to_regclass('billing.payment_orders') IS NULL THEN
    RAISE EXCEPTION '缺少 billing.payment_orders，请先执行 099_schema_split_phase1.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_core.runtime_config AS rc,
         jsonb_array_elements(COALESCE(rc.value -> 'rules', '[]'::jsonb)) AS r(rule)
    WHERE rc.key = 'miniapp_invite_reward_rules'
      AND r.rule ->> 'rule_key' = 'invitee_first_paid'
  ) THEN
    RAISE EXCEPTION 'miniapp_invite_reward_rules 里没有 invitee_first_paid 规则，请先核对 105/108 的配置';
  END IF;
END;
$$;

-- ─── 1. RPC：判定被邀请人这笔订单是否首付并幂等发奖 ─────────────────────────
CREATE OR REPLACE FUNCTION miniapp_traffic.check_invite_first_paid_reward(
  p_invitee_user_id UUID,
  p_order_id TEXT
) RETURNS TABLE (status TEXT, credits INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_relation miniapp_traffic.invite_relations%ROWTYPE;
  v_order billing.payment_orders%ROWTYPE;
  v_settled_orders BIGINT;
  v_already_granted BOOLEAN;
  v_grant RECORD;
BEGIN
  -- 绝大多数付费用户没有邀请关系，先用一次主键级查询短路掉。
  SELECT r.* INTO v_relation
  FROM miniapp_traffic.invite_relations AS r
  WHERE r.invitee_user_id = p_invitee_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_relation'::TEXT, 0;
    RETURN;
  END IF;

  SELECT o.* INTO v_order
  FROM billing.payment_orders AS o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'check_invite_first_paid_reward: 支付订单 % 不存在', p_order_id
      USING ERRCODE = '22023';
  END IF;

  IF v_order.user_id IS DISTINCT FROM p_invitee_user_id THEN
    RAISE EXCEPTION 'check_invite_first_paid_reward: 订单 % 不属于用户 %',
      p_order_id, p_invitee_user_id
      USING ERRCODE = '22023';
  END IF;

  -- 只认已入账的订单。挂点在 complete_payment_order 之后调用，正常路径必然满足；
  -- 不满足说明调用点用错了时机，此时宁可不发也不能凭未入账的订单发奖。
  IF v_order.status <> 'completed' OR v_order.credits_added IS NOT TRUE THEN
    RETURN QUERY SELECT 'not_settled'::TEXT, 0;
    RETURN;
  END IF;

  -- 「首次付费」不能读 billing.user_wallets.first_paid_at：complete_payment_order 已经把它
  -- 置成本次付费时间，挂点跑在入账之后，那个字段永远非空、区分不出是不是首笔。
  -- 改数该用户已入账的订单笔数，本笔自己也在内，所以 >1 即非首付。
  -- 代价：同一用户两笔订单几乎同时入账时，后入账那笔先跑到这里会把两笔都判成非首付，
  -- 奖励漏发。挂点与入账在同一请求内紧邻执行，这个窗口极窄；宁可漏发也不重发。
  SELECT count(*) INTO v_settled_orders
  FROM billing.payment_orders AS o
  WHERE o.user_id = p_invitee_user_id
    AND o.status = 'completed'
    AND o.credits_added IS TRUE;

  IF v_settled_orders > 1 THEN
    RETURN QUERY SELECT 'not_first_paid'::TEXT, 0;
    RETURN;
  END IF;

  -- 规则级去重。grant_invite_reward 的唯一键是 (关系, 规则, event_ref)，只能吸收同一订单的
  -- 重放；这里保证一个关系无论有多少订单都只拿一次首付奖励（例如订单数据被人工修订后重跑挂点）。
  SELECT EXISTS (
    SELECT 1
    FROM miniapp_traffic.invite_reward_logs AS l
    WHERE l.relation_id = v_relation.id
      AND l.rule_key = 'invitee_first_paid'
  ) INTO v_already_granted;

  IF v_already_granted THEN
    RETURN QUERY SELECT 'duplicated'::TEXT, 0;
    RETURN;
  END IF;

  -- 规则开关、金额与单关系累计上限全部由 grant_invite_reward 裁决：
  -- 规则没启用返回 skipped，触顶返回 cap_reached 或截断金额。
  SELECT * INTO v_grant
  FROM miniapp_traffic.grant_invite_reward(
    v_relation.id,
    'invitee_first_paid',
    p_order_id
  );

  RETURN QUERY SELECT v_grant.status::TEXT, v_grant.credits::INTEGER;
END;
$$;

COMMENT ON FUNCTION miniapp_traffic.check_invite_first_paid_reward(UUID, TEXT) IS
  '判定该已入账订单是否为被邀请人首笔付费（数已入账订单笔数，不看 user_wallets.first_paid_at），达标后复用 grant_invite_reward 幂等发放 invitee_first_paid；同一关系只发一次。';

-- ─── 2. RPC 权限 ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION miniapp_traffic.check_invite_first_paid_reward(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_traffic.check_invite_first_paid_reward(UUID, TEXT)
  TO service_role, postgres;

-- ─── 3. 自检 ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rule JSONB;
BEGIN
  IF to_regprocedure('miniapp_traffic.check_invite_first_paid_reward(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '109 自检失败：check_invite_first_paid_reward RPC 缺失';
  END IF;

  -- 不存在的用户必然没有邀请关系，可以安全地走一次真实调用验证函数体可执行。
  IF (
    SELECT c.status
    FROM miniapp_traffic.check_invite_first_paid_reward(
      '00000000-0000-0000-0000-000000000000'::uuid, '109-selfcheck'
    ) AS c
  ) IS DISTINCT FROM 'no_relation' THEN
    RAISE EXCEPTION '109 自检失败：无邀请关系的用户未返回 no_relation';
  END IF;

  SELECT r.rule INTO v_rule
  FROM app_core.runtime_config AS rc,
       jsonb_array_elements(rc.value -> 'rules') AS r(rule)
  WHERE rc.key = 'miniapp_invite_reward_rules'
    AND r.rule ->> 'rule_key' = 'invitee_first_paid';

  -- 本迁移只接挂点不动开关：翻 enabled 是运营在 admin 的发布动作。
  RAISE NOTICE '109: invitee_first_paid 当前配置 = %', v_rule;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
