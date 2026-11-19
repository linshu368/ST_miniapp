-- Domain: billing（支付订单）+ ops（支付操作事件）——数据库重组阶段 4a（收缩步）。
-- 计划见 .trellis/tasks/11-18-db-reorg-p4-jobs/design.md 4a。
--
-- 前置：20261118_db_reorg_p4a_payment_reconcile_jobs.sql 已执行；生产后端已改用 claim_payment_reconcile_jobs 与
--   ops.payment_events，并核对旧写法（next_reconcile_at 更新、经兼容视图的事件读写）停涨。
-- 步骤（同一事务）：
--   1. 守卫：除兼容视图本身外，不得再有函数/视图引用 billing.payment_operation_events；
--      不得再有函数/视图读 payment_orders 的对账列与结账确认列；
--   2. 删兼容视图；删 payment_orders 的 4 个对账调度列、3 个结账确认列及其索引与约束。
--
-- Verify: bash scripts/test-db-reorg-p4a-migration.sh（末段）。
-- Release: TEST -> Production。
-- Recovery: 不可逆（调度状态在 payment_reconcile_jobs，结账确认事实在 ops.payment_events 的 checkout_confirmation 事件）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $contract$
DECLARE
  v_ref text;
BEGIN
  IF to_regclass('billing.payment_reconcile_jobs') IS NULL OR to_regclass('ops.payment_events') IS NULL THEN
    RAISE EXCEPTION 'apply 20261118_db_reorg_p4a_payment_reconcile_jobs.sql first';
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND (p.prosrc ~ 'payment_operation_events'
         OR p.prosrc ~ '\m(next_reconcile_at|last_reconciled_at|reconcile_attempts|reconcile_locked_until|checkout_confirmed_at|last_checkout_confirmed_at|checkout_confirm_count)\M');
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'functions still reference the old payment event table or retired order columns: %', v_ref;
  END IF;

  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_ref
  FROM pg_depend d
  JOIN pg_rewrite rw ON rw.oid = d.objid
  JOIN pg_class v ON v.oid = rw.ev_class
  LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.classid = 'pg_rewrite'::regclass AND v.oid <> d.refobjid
    AND ((d.refobjid = to_regclass('billing.payment_operation_events') AND v.oid <> to_regclass('billing.payment_operation_events'))
      OR (d.refobjid = 'billing.payment_orders'::regclass
          AND a.attname IN ('next_reconcile_at', 'last_reconciled_at', 'reconcile_attempts', 'reconcile_locked_until',
                            'checkout_confirmed_at', 'last_checkout_confirmed_at', 'checkout_confirm_count')));
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'views still depend on the old payment event table or retired order columns: %', v_ref;
  END IF;
END
$contract$;

DROP VIEW IF EXISTS billing.payment_operation_events;

DROP INDEX IF EXISTS billing.idx_payment_orders_due_reconcile;
DROP INDEX IF EXISTS billing.idx_payment_orders_checkout_confirmed_at;
ALTER TABLE billing.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_checkout_confirm_count_nonnegative;
ALTER TABLE billing.payment_orders
  DROP COLUMN IF EXISTS next_reconcile_at,
  DROP COLUMN IF EXISTS last_reconciled_at,
  DROP COLUMN IF EXISTS reconcile_attempts,
  DROP COLUMN IF EXISTS reconcile_locked_until,
  DROP COLUMN IF EXISTS checkout_confirmed_at,
  DROP COLUMN IF EXISTS last_checkout_confirmed_at,
  DROP COLUMN IF EXISTS checkout_confirm_count;

NOTIFY pgrst, 'reload schema';
COMMIT;
