-- Domain: billing（支付对账任务 J）+ ops（支付操作事件 O）——数据库重组阶段 4a（扩展步）。
-- 规则见 docs/db/CONTRACT.md，计划见 .trellis/tasks/11-18-db-reorg-p4-jobs/design.md 4a。
--
-- 1. 新表 billing.payment_reconcile_jobs：每张可对账订单一行（次数、下次查单时间），插单触发器建行，
--    回填 7 天内仍可对账的订单。对账调度从 payment_orders 的 4 个列挪到这里（收缩步删列）。
-- 2. billing.claim_payment_reconcile_jobs：清掉已入账/已终结/出窗口的任务，领取到期任务并按指数退避
--    （base·2^attempts，封顶 max）排下一次，返回订单行。修"每 30 秒查同一批未付单、连查 7 天"的 bug。
-- 3. billing.payment_operation_events 整表搬到 ops.payment_events（数据、索引、约束、授权随表走），
--    旧位置留同名兼容视图（security_invoker），供发布前的旧后端照常读写（含 ON CONFLICT 去重）。
-- 4. 删无调用方的 billing.record_checkout_confirmation（调用方 11-03 换渠道时已删）。
--
-- Verify: bash scripts/test-db-reorg-p4a-migration.sh
-- Release: TEST -> Production -> 后端发布（对账改用 claim、事件改读写 ops）-> 核对 -> 收缩步。
-- Recovery: 旧列仍在、兼容视图在，回退后端即可；数据库回退 = 删视图后把 ops.payment_events 搬回原名原处。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF to_regnamespace('ops') IS NULL THEN
    RAISE EXCEPTION 'schema ops missing: apply 20261117_db_reorg_ops_cs_feed.sql first';
  END IF;
  IF to_regclass('billing.payment_orders') IS NULL THEN
    RAISE EXCEPTION 'billing.payment_orders missing';
  END IF;
END
$pre$;

-- 1. 对账任务表 -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.payment_reconcile_jobs (
  order_id text PRIMARY KEY REFERENCES billing.payment_orders(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now() + interval '1 minute',
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_reconcile_jobs_due_idx ON billing.payment_reconcile_jobs (next_attempt_at);
COMMENT ON TABLE billing.payment_reconcile_jobs IS
  '支付对账任务（J）：每张可对账订单一行，插单触发器建行。只经 billing.claim_payment_reconcile_jobs 领取与退避；订单入账/终结/出 7 天窗口后在领取时删除。';
ALTER TABLE billing.payment_reconcile_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.payment_reconcile_jobs FROM PUBLIC;
DO $acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON billing.payment_reconcile_jobs FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON billing.payment_reconcile_jobs TO service_role;
  END IF;
END
$acl$;

INSERT INTO billing.payment_reconcile_jobs (order_id)
SELECT o.id FROM billing.payment_orders o
WHERE o.status IN ('pending', 'expired') AND NOT o.credits_added AND NOT o.fulfillment_applied
  AND o.id LIKE 'EP%' AND o.created_at >= now() - interval '7 days'
ON CONFLICT (order_id) DO NOTHING;

CREATE OR REPLACE FUNCTION billing.tf_payment_orders_create_reconcile_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  INSERT INTO billing.payment_reconcile_jobs (order_id) VALUES (NEW.id) ON CONFLICT (order_id) DO NOTHING;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION billing.tf_payment_orders_create_reconcile_job() FROM PUBLIC;
DROP TRIGGER IF EXISTS payment_orders_create_reconcile_job ON billing.payment_orders;
CREATE TRIGGER payment_orders_create_reconcile_job
  AFTER INSERT ON billing.payment_orders
  FOR EACH ROW EXECUTE FUNCTION billing.tf_payment_orders_create_reconcile_job();

-- 2. 领取 + 退避 -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.claim_payment_reconcile_jobs(
  p_now timestamptz,
  p_window_start timestamptz,
  p_limit integer,
  p_base_delay_seconds integer,
  p_max_delay_seconds integer
)
RETURNS SETOF billing.payment_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_now IS NULL OR p_window_start IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_base_delay_seconds IS NULL OR p_base_delay_seconds < 1
     OR p_max_delay_seconds IS NULL OR p_max_delay_seconds < p_base_delay_seconds THEN
    RAISE EXCEPTION 'invalid payment reconcile claim arguments' USING ERRCODE = '22023';
  END IF;

  -- 已入账、已终结、出窗口或非易支付的订单不再对账（迟到支付靠已验签回调与用户主动查单）。
  DELETE FROM billing.payment_reconcile_jobs AS job
  USING billing.payment_orders AS o
  WHERE o.id = job.order_id
    AND (o.status NOT IN ('pending', 'expired') OR o.credits_added OR o.fulfillment_applied
         OR o.created_at < p_window_start OR o.id NOT LIKE 'EP%');

  -- 先排好下一次再交给调用方查单：崩溃或超时后到点会重领，结算幂等兜底重复查单。
  RETURN QUERY
  WITH due AS (
    SELECT job.order_id
    FROM billing.payment_reconcile_jobs AS job
    WHERE job.next_attempt_at <= p_now
    ORDER BY job.next_attempt_at, job.order_id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE billing.payment_reconcile_jobs AS job
    SET attempts = job.attempts + 1,
        last_attempt_at = p_now,
        next_attempt_at = p_now + make_interval(secs => least(
          p_base_delay_seconds * power(2::double precision, least(job.attempts, 30)),
          p_max_delay_seconds::double precision))
    FROM due
    WHERE job.order_id = due.order_id
    RETURNING job.order_id
  )
  SELECT o.*
  FROM billing.payment_orders AS o
  JOIN claimed ON claimed.order_id = o.id
  ORDER BY o.created_at, o.id;
END;
$function$;
REVOKE ALL ON FUNCTION billing.claim_payment_reconcile_jobs(timestamptz, timestamptz, integer, integer, integer) FROM PUBLIC;
DO $claim_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION billing.claim_payment_reconcile_jobs(timestamptz, timestamptz, integer, integer, integer) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION billing.claim_payment_reconcile_jobs(timestamptz, timestamptz, integer, integer, integer) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION billing.claim_payment_reconcile_jobs(timestamptz, timestamptz, integer, integer, integer) TO service_role;
  END IF;
END
$claim_acl$;

-- 3. 支付事件整表迁 ops ----------------------------------------------------------------------------
DO $move$
DECLARE
  r record;
BEGIN
  IF to_regclass('ops.payment_events') IS NULL THEN
    ALTER TABLE billing.payment_operation_events SET SCHEMA ops;
    ALTER TABLE ops.payment_operation_events RENAME TO payment_events;
  END IF;
  FOR r IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'ops.payment_events'::regclass AND conname LIKE 'payment\_operation\_events\_%' LOOP
    EXECUTE format('ALTER TABLE ops.payment_events RENAME CONSTRAINT %I TO %I',
      r.conname, 'payment_events_' || substr(r.conname, length('payment_operation_events_') + 1));
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           WHERE i.indrelid = 'ops.payment_events'::regclass
             AND (c.relname LIKE 'payment\_operation\_events\_%' OR c.relname LIKE 'idx\_payment\_operation\_events\_%') LOOP
    EXECUTE format('ALTER INDEX ops.%I RENAME TO %I', r.relname, replace(r.relname, 'payment_operation_events', 'payment_events'));
  END LOOP;
END
$move$;
COMMENT ON TABLE ops.payment_events IS
  '支付操作事件（O，只追加）：建单、收银台确认、回调、查单、对账、结算的事实，event_key 去重。PaymentAlertMonitor 读近 1 小时。原 billing.payment_operation_events（4a 迁入）。';

CREATE OR REPLACE VIEW billing.payment_operation_events WITH (security_invoker = true) AS
  SELECT * FROM ops.payment_events;
COMMENT ON VIEW billing.payment_operation_events IS '4a 发布窗口兼容视图：旧后端经 PostgREST 读写；收缩步删除。';
REVOKE ALL ON billing.payment_operation_events FROM PUBLIC;
DO $view_acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON billing.payment_operation_events FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON billing.payment_operation_events TO service_role;
  END IF;
END
$view_acl$;

-- 4. 无调用方的结账确认函数 -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS billing.record_checkout_confirmation(text, uuid, uuid, timestamptz, text);

NOTIFY pgrst, 'reload schema';
COMMIT;
