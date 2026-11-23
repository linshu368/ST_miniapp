-- Domain: billing（文本扣费）——数据库重组阶段 6b-1c 读方切换前置：扣费时刻记进 usage_charges.quote.charge.charged_at。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1c 盘点）。
--
-- 消费记录要从旧扣费表 billing.llm_usage_charges 改读 usage_charges（旧表在 6b-1c 收缩时删除）。
-- 两边逐条一致（11-21 生产只读：近 7 天有扣费的 612 个用户、各取最近 100 条，共 26299 条，条目与金额、状态、型号、metadata 全同），
-- 只有时间不同：旧表是扣费时刻，usage_charges.created_at 是这一轮开始的时间（早 11 秒～3.5 分钟），结算时间也会晚于扣费。
-- 本文件把扣费时刻原样带进新表，消费记录显示的时间不变：
--   1. 旧扣费表的镜像触发器在 quote.charge 里多写 charged_at = 旧表 created_at
--      （守卫原文 md5，恰好替换一处，核对结果 md5；已是新版本跳过）；
--   2. 存量按旧表回填，分 3 个固定边界的窗口，只改不一致的行，可重跑；
--   3. 自检：旧表每一行在新表都有相同的 charged_at。
--
-- Verify: bash scripts/test-db-reorg-p6b1c-charge-time.sh
-- Release: TEST -> Production（先于读新表的后端发布；后端缺 charged_at 时退回 created_at）。

DO $mirror$
DECLARE
  v_fn regprocedure := 'billing.tf_mirror_llm_usage_charge()'::regprocedure;
  v_md5 text;
  v_def text;
  v_old constant text := $o$'reconciled_at', NEW.reconciled_at)),$o$;
  v_new constant text := $n$'reconciled_at', NEW.reconciled_at, 'charged_at', NEW.created_at)),$n$;
BEGIN
  SET LOCAL lock_timeout = '1s';
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = '45436214be701b6b77e40c7be9a2d30a' THEN
    RAISE NOTICE 'p6b1c-charge-time: mirror trigger already records charged_at';
    RETURN;
  ELSIF v_md5 <> '3d0e300e4e0a3c58b7f37dfa12865053' THEN
    RAISE EXCEPTION 'p6b1c-charge-time: tf_mirror_llm_usage_charge drifted (md5 %), refusing', v_md5;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'p6b1c-charge-time: anchor not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 <> '45436214be701b6b77e40c7be9a2d30a' THEN
    RAISE EXCEPTION 'p6b1c-charge-time: unexpected md5 % after patch', v_md5;
  END IF;
  RAISE NOTICE 'p6b1c-charge-time: mirror trigger now records charged_at';
END
$mirror$;

CREATE OR REPLACE FUNCTION billing.p6b1c_backfill_charge_time(p_from timestamptz, p_to timestamptz)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_rows bigint;
BEGIN
  UPDATE billing.usage_charges u
  SET quote = jsonb_set(u.quote, '{charge,charged_at}', to_jsonb(c.created_at)), updated_at = now()
  FROM billing.llm_usage_charges c
  WHERE c.charge_key = u.id AND c.created_at >= p_from AND c.created_at < p_to
    AND u.quote ? 'charge'
    AND (u.quote -> 'charge' ->> 'charged_at')::timestamptz IS DISTINCT FROM c.created_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN format('%s .. %s: %s rows', p_from, p_to, v_rows);
END
$fn$;

SELECT billing.p6b1c_backfill_charge_time('-infinity', '2026-10-15 00:00+08');
SELECT billing.p6b1c_backfill_charge_time('2026-10-15 00:00+08', '2026-11-10 00:00+08');
SELECT billing.p6b1c_backfill_charge_time('2026-11-10 00:00+08', 'infinity');
DROP FUNCTION billing.p6b1c_backfill_charge_time(timestamptz, timestamptz);

DO $check$
DECLARE
  v_missing bigint;
  v_total bigint;
BEGIN
  SELECT count(*) FILTER (WHERE (u.quote -> 'charge' ->> 'charged_at')::timestamptz IS DISTINCT FROM c.created_at), count(*)
  INTO v_missing, v_total
  FROM billing.llm_usage_charges c JOIN billing.usage_charges u ON u.id = c.charge_key;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'p6b1c-charge-time: % / % charges lack the original charge time', v_missing, v_total;
  END IF;
  RAISE NOTICE 'p6b1c-charge-time: all % charges carry their original charge time', v_total;
END
$check$;
