-- Domain: ops（支付操作事件 O）——数据库重组阶段 4a 的写入入口补丁。
-- 计划见 .trellis/tasks/11-18-db-reorg-p4-jobs/design.md 4a。
--
-- 背景：4a 后端把支付事件写入改成 Prisma 原生 SQL 写 ops.payment_events。生产上对账 worker / payment-cron 两个
--   Railway 服务的 DATABASE_URL 与主服务不同（事务池 6543），这两个服务此前只用 Supabase 客户端、从未用过 Prisma，
--   发布后它们的事件写入全部失败（对账、退避本身正常，只丢事件）。
-- 本文件：加 billing.record_payment_event —— 经 PostgREST（service_role）调用、SECURITY DEFINER 写 ops.payment_events，
--   event_key 去重。后端事件写入改走它，与订单读写同一通道，不再依赖各服务的 Prisma 连接配置。ops 仍不暴露。
--
-- Verify: bash scripts/test-db-reorg-p4a-migration.sh（record_payment_event 段）。
-- Release: TEST -> Production -> 后端发布。
-- Recovery: 删函数即可（后端回到 Prisma 写法）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF to_regclass('ops.payment_events') IS NULL THEN
    RAISE EXCEPTION 'apply 20261118_db_reorg_p4a_payment_reconcile_jobs.sql first';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION billing.record_payment_event(
  p_event_key text,
  p_order_id text,
  p_user_id uuid,
  p_event_kind text,
  p_stage text,
  p_outcome text,
  p_source text,
  p_trigger text,
  p_error_class text,
  p_duration_ms integer,
  p_occurred_at timestamptz,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  -- 取值范围由表上的 CHECK 约束兜底；同一事实（event_key）重复上报直接忽略，返回 false。
  INSERT INTO ops.payment_events (event_key, order_id, user_id, event_kind, stage, outcome, source, trigger,
    error_class, duration_ms, occurred_at, metadata)
  VALUES (p_event_key, p_order_id, p_user_id, p_event_kind, p_stage, p_outcome, p_source, p_trigger,
    p_error_class, p_duration_ms, p_occurred_at, coalesce(p_metadata, '{}'::jsonb))
  ON CONFLICT (event_key) DO NOTHING;
  RETURN FOUND;
END;
$function$;
COMMENT ON FUNCTION billing.record_payment_event(text, text, uuid, text, text, text, text, text, text, integer, timestamptz, jsonb) IS
  '支付操作事件唯一写入口（后端经 PostgREST 调用）：写 ops.payment_events，event_key 去重，重复返回 false。';
REVOKE ALL ON FUNCTION billing.record_payment_event(text, text, uuid, text, text, text, text, text, text, integer, timestamptz, jsonb) FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION billing.record_payment_event(text, text, uuid, text, text, text, text, text, text, integer, timestamptz, jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION billing.record_payment_event(text, text, uuid, text, text, text, text, text, text, integer, timestamptz, jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION billing.record_payment_event(text, text, uuid, text, text, text, text, text, text, integer, timestamptz, jsonb) TO service_role;
  END IF;
END
$acl$;

NOTIFY pgrst, 'reload schema';
COMMIT;
