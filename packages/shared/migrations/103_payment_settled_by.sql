-- 103: 支付订单入账来源（settled_by）
--
-- 「这笔星尘是靠哪条路进来的」此前只在日志里，订单行上没有，日报无法用一条 SQL 统计
-- 四条入账路径的分布与耗时。本迁移把获胜路径落到订单行上。
--
-- 取值与后端 SettlementSource 一一对应：webhook | return | query | cron。
-- 只有真正翻状态的那一次写入；重复确认走 credits_added 幂等的提前返回，不覆盖，
-- 因此同一订单被两条路径抢着确认时记录的是先到的那条。
--
-- 双 schema 兼容：production 尚未执行 099，订单表在 miniapp；test 已执行 099，在 billing。
-- 与 100 同一套探测方式，只改实际存在的那一套，可独立应用到两个环境。
--
-- 函数签名从 (TEXT, TEXT) 变成 (TEXT, TEXT, TEXT)，第三参带 DEFAULT NULL：
--   · 迁移先于代码发布，旧代码只传两参仍能命中新函数，发布窗口内不会断
--   · 新旧签名不能共存（两参调用会因重载而歧义，099 preflight 也拒绝同名重载），
--     所以创建与删除必须在同一事务里完成——整段包在一个 DO 块内即为一条语句

DO $migration$
DECLARE
  target_schema TEXT;
BEGIN
  IF to_regclass('billing.payment_orders') IS NOT NULL THEN
    target_schema := 'billing';
  ELSIF to_regclass('miniapp.payment_orders') IS NOT NULL THEN
    target_schema := 'miniapp';
  ELSE
    RAISE EXCEPTION '103: payment_orders 不在 billing 也不在 miniapp';
  END IF;

  -- 入账函数同时写钱包与流水，三张表必须同域；否则重建出来的函数会指向不存在的表。
  IF to_regclass(format('%I.user_wallets', target_schema)) IS NULL
     OR to_regclass(format('%I.wallet_ledger', target_schema)) IS NULL THEN
    RAISE EXCEPTION '103: %.user_wallets / %.wallet_ledger 缺失，三张表不同域，需先确认归属',
      target_schema, target_schema;
  END IF;

  IF to_regprocedure(format('%I.complete_payment_order(TEXT, TEXT)', target_schema)) IS NULL
     AND to_regprocedure(format('%I.complete_payment_order(TEXT, TEXT, TEXT)', target_schema))
         IS NULL THEN
    RAISE EXCEPTION '103: %.complete_payment_order 不存在，schema 归属与预期不符', target_schema;
  END IF;

  EXECUTE format(
    'ALTER TABLE %I.payment_orders ADD COLUMN IF NOT EXISTS settled_by TEXT',
    target_schema
  );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payment_orders_settled_by_check'
      AND conrelid = format('%I.payment_orders', target_schema)::regclass
  ) THEN
    -- 历史行是 NULL，CHECK 允许 NULL，因此不需要回填也能加上约束。
    EXECUTE format(
      'ALTER TABLE %I.payment_orders
         ADD CONSTRAINT payment_orders_settled_by_check
         CHECK (settled_by IN (''webhook'', ''return'', ''query'', ''cron''))',
      target_schema
    );
  END IF;

  EXECUTE format(
    $fn$
CREATE OR REPLACE FUNCTION %1$I.complete_payment_order(
  p_order_id TEXT,
  p_provider_transaction_id TEXT,
  p_settled_by TEXT DEFAULT NULL
) RETURNS %1$I.payment_orders
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
  v_order %1$I.payment_orders;
  v_wallet %1$I.user_wallets;
  v_paid_amount NUMERIC(12, 2);
BEGIN
  SELECT *
  INTO v_order
  FROM %1$I.payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found: %%', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status = 'completed' AND v_order.credits_added = true THEN
    RETURN v_order;
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'payment order is not pending: %%', p_order_id
      USING ERRCODE = 'P0001';
  END IF;

  v_paid_amount := (v_order.amount_cents::NUMERIC / 100)::NUMERIC(12, 2);

  UPDATE %1$I.payment_orders
  SET
    status = 'completed',
    provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
    credits_added = true,
    settled_by = COALESCE(p_settled_by, settled_by),
    paid_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  INSERT INTO %1$I.user_wallets (
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
    now(),
    now(),
    v_paid_amount,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    main_credits = %1$I.user_wallets.main_credits + EXCLUDED.main_credits,
    bonus_credits = %1$I.user_wallets.bonus_credits + EXCLUDED.bonus_credits,
    first_paid_at = COALESCE(%1$I.user_wallets.first_paid_at, EXCLUDED.first_paid_at),
    last_paid_at = EXCLUDED.last_paid_at,
    total_paid_amount = %1$I.user_wallets.total_paid_amount + EXCLUDED.total_paid_amount,
    updated_at = now()
  RETURNING * INTO v_wallet;

  INSERT INTO %1$I.wallet_ledger (
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
      'settled_by', v_order.settled_by
    )
  );

  RETURN v_order;
END;
$body$
    $fn$,
    target_schema
  );

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION %I.complete_payment_order(TEXT, TEXT, TEXT)
       TO service_role, postgres',
    target_schema
  );

  EXECUTE format(
    'DROP FUNCTION IF EXISTS %I.complete_payment_order(TEXT, TEXT)',
    target_schema
  );

  EXECUTE format(
    'COMMENT ON COLUMN %I.payment_orders.settled_by IS
       ''入账获胜路径：webhook 厂商异步通知 / return 同步回跳 / query 前端轮询查单 /
         cron 定时兜底查单。仅入账那一次写入，历史订单为 NULL。''',
    target_schema
  );

  EXECUTE format(
    'COMMENT ON FUNCTION %I.complete_payment_order(TEXT, TEXT, TEXT) IS
       ''支付订单入账：翻状态、加星尘、记流水，并记录本次入账来源 settled_by。
         p_settled_by 为 NULL 时不改动已有来源。''',
    target_schema
  );
END
$migration$;

-- PostgREST 缓存函数签名，签名变了必须让它重载，否则 rpc 调用仍按两参解析。
NOTIFY pgrst, 'reload schema';
