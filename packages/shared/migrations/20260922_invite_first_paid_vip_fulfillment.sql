-- 20260922_invite_first_paid_vip_fulfillment.sql
-- domain: miniapp_traffic + billing
--
-- T3 forward-fix：邀请「首次现金支付」把已履约 VIP 订单算进去。
-- 不改 109_invite_first_paid_reward.sql。不改发奖金额、规则开关或 grant_invite_reward。
--
-- 旧谓词只认 credits_added。VIP 履约把该列留为 false，并用 fulfillment_applied。
-- 新谓词与支付侧一致：fulfillment_applied，或非 VIP 商品的 credits_added。
-- 同一订单重放仍由 invite_reward_logs 与 grant 唯一键去重。
--
-- 前置：109 已建立 check_invite_first_paid_reward；T2 已有 payment_orders.fulfillment_applied。
-- 锁：只替换函数，不改表、不建索引。lock_timeout 5s，statement_timeout 60s。
-- 执行：GitHub Actions Database Migration，environment=test，一次一个文件。
--       本文件未获明确批准不得 apply。禁止对 Production 执行。
-- 恢复：已发出的邀请奖励不追回。若要退回旧谓词，另写 forward-fix 恢复只认 credits_added 的函数体。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regprocedure('miniapp_traffic.check_invite_first_paid_reward(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '20260922_invite_first_paid_vip_fulfillment: check_invite_first_paid_reward missing';
  END IF;
  IF to_regprocedure('miniapp_traffic.grant_invite_reward(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '20260922_invite_first_paid_vip_fulfillment: grant_invite_reward missing';
  END IF;
  IF to_regclass('miniapp_traffic.invite_relations') IS NULL
     OR to_regclass('miniapp_traffic.invite_reward_logs') IS NULL
     OR to_regclass('billing.payment_orders') IS NULL THEN
    RAISE EXCEPTION '20260922_invite_first_paid_vip_fulfillment: invite or payment tables missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'billing'
      AND table_name = 'payment_orders'
      AND column_name = 'fulfillment_applied'
  ) THEN
    RAISE EXCEPTION '20260922_invite_first_paid_vip_fulfillment: fulfillment_applied missing';
  END IF;
END;
$$;

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

  -- VIP 履约后 credits_added 仍为 false。已履约现金支付认 fulfillment_applied；
  -- 非 VIP 的历史行在 fulfillment 回填前仍认 credits_added。
  IF v_order.status <> 'completed'
     OR NOT (
       COALESCE(v_order.fulfillment_applied, false)
       OR (
         COALESCE(v_order.product_type, 'credits') <> 'vip'
         AND v_order.credits_added IS TRUE
       )
     ) THEN
    RETURN QUERY SELECT 'not_settled'::TEXT, 0;
    RETURN;
  END IF;

  -- 本笔自己也在计数里，所以 >1 才不是首笔。不读 first_paid_at，履约后它已经非空。
  SELECT count(*) INTO v_settled_orders
  FROM billing.payment_orders AS o
  WHERE o.user_id = p_invitee_user_id
    AND o.status = 'completed'
    AND (
      COALESCE(o.fulfillment_applied, false)
      OR (
        COALESCE(o.product_type, 'credits') <> 'vip'
        AND o.credits_added IS TRUE
      )
    );

  IF v_settled_orders > 1 THEN
    RETURN QUERY SELECT 'not_first_paid'::TEXT, 0;
    RETURN;
  END IF;

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

  SELECT * INTO v_grant
  FROM miniapp_traffic.grant_invite_reward(
    v_relation.id,
    'invitee_first_paid',
    p_order_id
  );

  RETURN QUERY SELECT v_grant.status::TEXT, v_grant.credits::INTEGER;
END;
$$;

REVOKE ALL ON FUNCTION miniapp_traffic.check_invite_first_paid_reward(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_traffic.check_invite_first_paid_reward(UUID, TEXT)
  TO service_role, postgres;

COMMENT ON FUNCTION miniapp_traffic.check_invite_first_paid_reward(UUID, TEXT) IS
  '判定已履约现金支付是否为被邀请人首笔。VIP 认 fulfillment_applied；credits 历史行仍可认 credits_added。同一关系只发一次 invitee_first_paid。';

DO $$
DECLARE
  v_cfg TEXT[];
  v_src TEXT;
BEGIN
  SELECT proconfig, pg_get_functiondef(oid) INTO v_cfg, v_src
  FROM pg_proc
  WHERE oid = 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)'::regprocedure;

  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: check_invite_first_paid_reward search_path is not pg_catalog';
  END IF;
  IF position('fulfillment_applied' IN v_src) = 0
     OR position('not_first_paid' IN v_src) = 0
     OR position('duplicated' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postflight: invite first-paid function is missing the VIP fulfillment predicate';
  END IF;
  IF has_function_privilege('anon', 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: invite first-paid function must not be executable by anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: service_role must execute check_invite_first_paid_reward';
  END IF;

  IF (
    SELECT c.status
    FROM miniapp_traffic.check_invite_first_paid_reward(
      '00000000-0000-0000-0000-000000000000'::uuid,
      '20260922-invite-selfcheck'
    ) AS c
  ) IS DISTINCT FROM 'no_relation' THEN
    RAISE EXCEPTION 'postflight: missing invite relation did not return no_relation';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';
