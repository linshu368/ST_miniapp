-- 20260921_vip_payment_fulfillment.sql
-- domain: billing
--
-- T2 第 3/4 文件：兼容扩展 complete_payment_order。
-- 旧签名 (text, text, text default null) 保留，两参调用仍然命中本函数。
-- credits 商品保持入账行为；vip 商品顺延会员、写 grant，月卡走 grant_bonus_credits。
-- 因函数现在能发放会员与专项星尘，REVOKE PUBLIC EXECUTE（旧 PUBLIC 授权会阻止安全实现）。
-- 前置：20260921_vip_billing_schema.sql；billing.grant_bonus_credits。
-- 不改 Backend 调用方。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('billing.vip_memberships') IS NULL
     OR to_regclass('billing.vip_purchase_grants') IS NULL THEN
    RAISE EXCEPTION '20260921_vip_payment_fulfillment: run 20260921_vip_billing_schema.sql first';
  END IF;
  IF to_regprocedure('billing.complete_payment_order(text,text,text)') IS NULL THEN
    RAISE EXCEPTION '20260921_vip_payment_fulfillment: complete_payment_order(text,text,text) missing';
  END IF;
  IF to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260921_vip_payment_fulfillment: grant_bonus_credits missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'payment_orders' AND column_name = 'product_type'
  ) THEN
    RAISE EXCEPTION '20260921_vip_payment_fulfillment: payment_orders.product_type missing';
  END IF;
END;
$$;

UPDATE billing.payment_orders
SET fulfillment_applied = credits_added
WHERE product_type = 'credits'
  AND fulfillment_applied IS DISTINCT FROM credits_added;

CREATE OR REPLACE FUNCTION billing.complete_payment_order(
  p_order_id TEXT,
  p_provider_transaction_id TEXT,
  p_settled_by TEXT DEFAULT NULL
) RETURNS billing.payment_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_order billing.payment_orders;
  v_wallet billing.user_wallets;
  v_paid_amount NUMERIC(12, 2);
  v_now TIMESTAMPTZ := now();
  v_product_type TEXT;
  v_plan_id TEXT;
  v_duration INTEGER;
  v_bonus INTEGER;
  v_inserted INTEGER;
  v_membership billing.vip_memberships;
  v_previous_until TIMESTAMPTZ;
  v_new_from TIMESTAMPTZ;
  v_new_until TIMESTAMPTZ;
  v_base TIMESTAMPTZ;
  v_grant billing.vip_purchase_grants;
BEGIN
  SELECT *
  INTO v_order
  FROM billing.payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found: %', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  v_product_type := COALESCE(v_order.product_type, 'credits');

  IF v_order.status = 'completed'
     AND (
       v_order.fulfillment_applied
       OR (v_product_type = 'credits' AND v_order.credits_added)
     ) THEN
    RETURN v_order;
  END IF;

  IF EXISTS (
    SELECT 1 FROM billing.vip_purchase_grants WHERE order_id = p_order_id
  ) THEN
    SELECT * INTO v_order FROM billing.payment_orders WHERE id = p_order_id;
    RETURN v_order;
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'payment order is not pending: %', p_order_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_settled_by IS NOT NULL AND p_settled_by NOT IN ('webhook', 'return', 'query', 'cron') THEN
    RAISE EXCEPTION 'payment order settled_by is invalid: %', p_order_id
      USING ERRCODE = '22023';
  END IF;

  v_paid_amount := (v_order.amount_cents::NUMERIC / 100)::NUMERIC(12, 2);

  IF v_product_type = 'credits' THEN
    UPDATE billing.payment_orders
    SET
      status = 'completed',
      provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
      credits_added = true,
      fulfillment_applied = true,
      settled_by = COALESCE(p_settled_by, settled_by),
      paid_at = v_now
    WHERE id = p_order_id
    RETURNING * INTO v_order;

    INSERT INTO billing.user_wallets (
      user_id,
      main_credits,
      bonus_credits,
      first_paid_at,
      last_paid_at,
      total_paid_amount,
      updated_at
    ) VALUES (
      v_order.user_id,
      v_order.credits_amount,
      v_order.bonus_credits,
      v_now,
      v_now,
      v_paid_amount,
      v_now
    )
    ON CONFLICT (user_id) DO UPDATE
    SET
      main_credits = EXCLUDED.main_credits + billing.user_wallets.main_credits,
      bonus_credits = EXCLUDED.bonus_credits + billing.user_wallets.bonus_credits,
      first_paid_at = COALESCE(billing.user_wallets.first_paid_at, EXCLUDED.first_paid_at),
      last_paid_at = EXCLUDED.last_paid_at,
      total_paid_amount = billing.user_wallets.total_paid_amount + EXCLUDED.total_paid_amount,
      updated_at = now()
    RETURNING * INTO v_wallet;

    INSERT INTO billing.wallet_ledger (
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
      v_order.user_id,
      'recharge',
      v_order.credits_amount + v_order.bonus_credits,
      v_order.credits_amount,
      v_order.bonus_credits,
      v_wallet.main_credits,
      v_wallet.bonus_credits,
      'payment_order',
      v_order.id,
      jsonb_build_object(
        'provider_transaction_id', p_provider_transaction_id,
        'paid_amount', v_paid_amount,
        'settled_by', v_order.settled_by,
        'product_type', 'credits'
      )
    );

    RETURN v_order;
  END IF;

  IF v_product_type <> 'vip' THEN
    RAISE EXCEPTION 'unsupported payment product_type: %', v_product_type
      USING ERRCODE = '22023';
  END IF;

  v_plan_id := v_order.product_id;
  v_duration := v_order.vip_duration_days;
  v_bonus := COALESCE(v_order.vip_bonus_credits, 0);

  IF v_plan_id NOT IN ('week', 'month')
     OR v_order.credits_amount <> 0
     OR v_order.bonus_credits <> 0 THEN
    RAISE EXCEPTION 'vip payment snapshot is invalid: %', p_order_id
      USING ERRCODE = '22023';
  END IF;
  IF v_plan_id = 'week' AND (v_order.amount_cents <> 1399 OR v_duration <> 7 OR v_bonus <> 0) THEN
    RAISE EXCEPTION 'vip week snapshot is invalid: %', p_order_id
      USING ERRCODE = '22023';
  END IF;
  IF v_plan_id = 'month' AND (v_order.amount_cents <> 2888 OR v_duration <> 31 OR v_bonus <> 3000) THEN
    RAISE EXCEPTION 'vip month snapshot is invalid: %', p_order_id
      USING ERRCODE = '22023';
  END IF;

  -- 先锁会员行再动钱包，避免与签到（会员锁 → 钱包）形成死锁。
  INSERT INTO billing.vip_memberships (
    user_id,
    valid_from,
    valid_until,
    last_plan_id,
    version,
    created_at,
    updated_at
  ) VALUES (
    v_order.user_id,
    v_now,
    v_now + make_interval(days => v_duration),
    v_plan_id,
    1,
    v_now,
    v_now
  )
  ON CONFLICT (user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = v_order.user_id
  FOR UPDATE;

  IF v_inserted = 0 THEN
    v_previous_until := v_membership.valid_until;
    v_base := GREATEST(v_now, v_membership.valid_until);
    v_new_from := CASE
      WHEN v_membership.valid_until > v_now THEN v_membership.valid_from
      ELSE v_now
    END;
    v_new_until := v_base + make_interval(days => v_duration);

    UPDATE billing.vip_memberships
    SET
      valid_from = v_new_from,
      valid_until = v_new_until,
      last_plan_id = v_plan_id,
      version = billing.vip_memberships.version + 1,
      updated_at = v_now
    WHERE user_id = v_order.user_id
    RETURNING * INTO v_membership;
  ELSE
    v_previous_until := NULL;
    v_new_from := v_membership.valid_from;
    v_new_until := v_membership.valid_until;
  END IF;

  INSERT INTO billing.vip_purchase_grants (
    order_id,
    user_id,
    plan_id,
    amount_cents,
    duration_days,
    bonus_credits,
    previous_valid_until,
    new_valid_from,
    new_valid_until,
    granted_at
  ) VALUES (
    v_order.id,
    v_order.user_id,
    v_plan_id,
    v_order.amount_cents,
    v_duration,
    v_bonus,
    v_previous_until,
    v_new_from,
    v_new_until,
    v_now
  )
  RETURNING * INTO v_grant;

  INSERT INTO billing.user_wallets (
    user_id,
    first_paid_at,
    last_paid_at,
    total_paid_amount,
    updated_at
  ) VALUES (
    v_order.user_id,
    v_now,
    v_now,
    v_paid_amount,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    first_paid_at = COALESCE(billing.user_wallets.first_paid_at, EXCLUDED.first_paid_at),
    last_paid_at = EXCLUDED.last_paid_at,
    total_paid_amount = billing.user_wallets.total_paid_amount + EXCLUDED.total_paid_amount,
    updated_at = now();

  IF v_bonus > 0 THEN
    PERFORM billing.grant_bonus_credits(
      v_order.user_id,
      v_bonus,
      'vip_bonus',
      'payment_order',
      v_order.id,
      jsonb_build_object(
        'plan_id', v_plan_id,
        'order_id', v_order.id,
        'settled_by', COALESCE(p_settled_by, v_order.settled_by)
      )
    );
  END IF;

  UPDATE billing.payment_orders
  SET
    status = 'completed',
    provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
    credits_added = false,
    fulfillment_applied = true,
    settled_by = COALESCE(p_settled_by, settled_by),
    paid_at = v_now,
    vip_valid_until = v_new_until
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT) IS
  '支付唯一履约出口。credits 入主/赠送钱包；vip 锁会员顺延，月卡 3000 走 grant_bonus_credits。p_settled_by 默认 NULL。仅 service_role。';

DO $$
DECLARE
  v_cfg TEXT[];
  v_src TEXT;
BEGIN
  SELECT proconfig, pg_get_functiondef(oid) INTO v_cfg, v_src
  FROM pg_proc
  WHERE oid = 'billing.complete_payment_order(text,text,text)'::regprocedure;

  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: complete_payment_order search_path is not pg_catalog';
  END IF;
  IF position('vip_purchase_grants' IN v_src) = 0
     OR position('grant_bonus_credits' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postflight: complete_payment_order is not the VIP-aware body';
  END IF;
  IF has_function_privilege('anon', 'billing.complete_payment_order(text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.complete_payment_order(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: complete_payment_order must not be executable by anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'billing.complete_payment_order(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: service_role must execute complete_payment_order';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM billing.payment_orders
    WHERE product_type = 'credits'
      AND fulfillment_applied IS DISTINCT FROM credits_added
  ) THEN
    RAISE EXCEPTION 'postflight: credits orders must keep fulfillment_applied aligned with credits_added';
  END IF;
  IF to_regprocedure('billing.complete_payment_order(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'postflight: old two-arg complete_payment_order overload must stay dropped';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：不可恢复已售 VIP。forward-fix 新函数体。旧两参调用继续靠 DEFAULT NULL。
