-- 100: 支付订单快速对账调度
--
-- production 尚未执行 099，订单表在 miniapp；test 已执行 099，订单表在 billing。
-- 本迁移只修改实际存在的那一张表，因此可独立于 097-099 分别应用到两个环境。

DO $$
DECLARE
  target_schema TEXT;
BEGIN
  IF to_regclass('billing.payment_orders') IS NOT NULL THEN
    target_schema := 'billing';
  ELSIF to_regclass('miniapp.payment_orders') IS NOT NULL THEN
    target_schema := 'miniapp';
  ELSE
    RAISE EXCEPTION 'payment_orders not found in billing or miniapp schema';
  END IF;

  EXECUTE format(
    'ALTER TABLE %I.payment_orders
       ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ NOT NULL
         DEFAULT (now() + interval ''60 seconds''),
       ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
       ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS reconcile_locked_until TIMESTAMPTZ',
    target_schema
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_payment_orders_due_reconcile
       ON %I.payment_orders (next_reconcile_at)
       WHERE status = ''pending'' AND credits_added = false',
    target_schema
  );

  EXECUTE format(
    'COMMENT ON COLUMN %I.payment_orders.next_reconcile_at IS
       ''快速对账下次可领取时间；新订单默认创建约 60 秒后首次查单。''',
    target_schema
  );
  EXECUTE format(
    'COMMENT ON COLUMN %I.payment_orders.reconcile_locked_until IS
       ''快速对账领取租约；worker 中断后超过该时间可重新领取。''',
    target_schema
  );
END
$$;
