-- Domain: billing（文本扣费）——数据库重组阶段 6b-1b 前置修复：usage_charges.quote 里被删掉的 null 键补回来。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1b / 6b-1c 拆解）。
--
-- 6b-1a 的镜像触发器 tf_mirror_chat_history_charge 和回填都用了 jsonb_strip_nulls，它会递归删掉报价快照里
-- 值为 null 的键（discount_rate、vip_valid_until），回填时扣费明细 quote.charge 里的 null 键也一起删了。
-- 生产核对（11-21）：近 7 天 49593 轮里 47924 轮的 quote.snapshot 与 chat_history.llm_billing_snapshot 不同；
-- 去掉 null 后再比差异为 0。金额、结算时间、应扣不受影响，也还没有读者，6b-1b 改读之前必须原样。
-- 本文件：
--   1. 镜像触发器改为原样写快照（守卫 6b-1a 原文 md5，恰好替换一处，核对结果 md5；已是新版本跳过）；
--   2. 按轮次时间分 11 个窗口，每窗一条语句、单独提交：quote.snapshot 从轮次表原样重拷，
--      quote.charge 从扣费记录（还在的）按镜像同口径重建；只改不一致的行，可重跑；
--   3. 自检近 14 天：快照与轮次表逐行相等，扣费明细与扣费记录逐行相等。
--
-- Verify: bash scripts/test-db-reorg-p6b1b-fix-quote-nulls.sh
-- Release: TEST -> Production（不需要后端发布）。

DO $mirror$
DECLARE
  v_fn regprocedure := 'billing.tf_mirror_chat_history_charge()'::regprocedure;
  v_md5 text;
  v_def text;
  v_old constant text := $o$jsonb_strip_nulls(jsonb_build_object('snapshot', NEW.llm_billing_snapshot))$o$;
  v_new constant text := $n$CASE WHEN NEW.llm_billing_snapshot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('snapshot', NEW.llm_billing_snapshot) END$n$;
BEGIN
  SET LOCAL lock_timeout = '1s';
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = '1a1616a61ba4f3b42a032f08d7b8132a' THEN
    RAISE NOTICE 'p6b1b-quote: mirror trigger already keeps null snapshot keys';
    RETURN;
  ELSIF v_md5 <> 'e92dcad757394429b6b0d2b9ff134917' THEN
    RAISE EXCEPTION 'p6b1b-quote: tf_mirror_chat_history_charge drifted (md5 %), refusing', v_md5;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'p6b1b-quote: anchor not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 <> '1a1616a61ba4f3b42a032f08d7b8132a' THEN
    RAISE EXCEPTION 'p6b1b-quote: unexpected md5 % after patch', v_md5;
  END IF;
  RAISE NOTICE 'p6b1b-quote: mirror trigger now keeps null snapshot keys';
END
$mirror$;

CREATE OR REPLACE FUNCTION billing.p6b1b_fix_quote(p_from timestamptz, p_to timestamptz)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_snapshots bigint;
  v_charges bigint;
BEGIN
  UPDATE billing.usage_charges u
  SET quote = u.quote || jsonb_build_object('snapshot', h.llm_billing_snapshot), updated_at = now()
  FROM experience.chat_history h
  WHERE h.llm_charge_id = u.id AND h.created_at >= p_from AND h.created_at < p_to
    AND h.llm_billing_snapshot IS NOT NULL
    AND (u.quote -> 'snapshot') IS DISTINCT FROM h.llm_billing_snapshot;
  GET DIAGNOSTICS v_snapshots = ROW_COUNT;
  -- 与镜像触发器 tf_mirror_llm_usage_charge 同口径（不删 null）
  UPDATE billing.usage_charges u
  SET quote = u.quote || jsonb_build_object('charge', x.charge), updated_at = now()
  FROM (
    SELECT c.charge_key, jsonb_build_object(
      'model_id', c.model_id, 'model_openrouter_id', c.model_openrouter_id, 'model_display_name', c.model_display_name,
      'catalog_version', c.catalog_version, 'pricing_config_version', c.pricing_config_version,
      'exchange_rate', c.exchange_rate, 'model_markup', c.model_markup, 'initial_amount', c.initial_amount,
      'calculated_amount', c.calculated_amount, 'fallback_used', c.fallback_used, 'metadata', c.metadata,
      'reconciled_at', c.reconciled_at) AS charge
    FROM billing.llm_usage_charges c
    WHERE c.created_at >= p_from AND c.created_at < p_to
  ) x
  WHERE x.charge_key = u.id AND (u.quote -> 'charge') IS DISTINCT FROM x.charge;
  GET DIAGNOSTICS v_charges = ROW_COUNT;
  RETURN format('%s .. %s: snapshots %s, charges %s', p_from, p_to, v_snapshots, v_charges);
END
$fn$;

SELECT billing.p6b1b_fix_quote('-infinity', '2026-07-15 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-07-15 00:00+08', '2026-08-01 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-08-01 00:00+08', '2026-08-15 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-08-15 00:00+08', '2026-09-01 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-09-01 00:00+08', '2026-09-15 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-09-15 00:00+08', '2026-10-15 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-10-15 00:00+08', '2026-11-01 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-11-01 00:00+08', '2026-11-10 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-11-10 00:00+08', '2026-11-16 00:00+08');
SELECT billing.p6b1b_fix_quote('2026-11-16 00:00+08', now() - interval '1 hour');
SELECT billing.p6b1b_fix_quote(now() - interval '1 hour', 'infinity');
DROP FUNCTION billing.p6b1b_fix_quote(timestamptz, timestamptz);

DO $check$
DECLARE
  v_snapshot_diff bigint;
  v_charge_diff bigint;
BEGIN
  SELECT count(*) INTO v_snapshot_diff
  FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
  WHERE h.created_at > now() - interval '14 days' AND h.llm_billing_snapshot IS NOT NULL
    AND (u.quote -> 'snapshot') IS DISTINCT FROM h.llm_billing_snapshot;
  SELECT count(*) INTO v_charge_diff
  FROM billing.llm_usage_charges c JOIN billing.usage_charges u ON u.id = c.charge_key
  WHERE c.created_at > now() - interval '14 days'
    AND (u.quote -> 'charge') IS DISTINCT FROM jsonb_build_object(
      'model_id', c.model_id, 'model_openrouter_id', c.model_openrouter_id, 'model_display_name', c.model_display_name,
      'catalog_version', c.catalog_version, 'pricing_config_version', c.pricing_config_version,
      'exchange_rate', c.exchange_rate, 'model_markup', c.model_markup, 'initial_amount', c.initial_amount,
      'calculated_amount', c.calculated_amount, 'fallback_used', c.fallback_used, 'metadata', c.metadata,
      'reconciled_at', c.reconciled_at);
  IF v_snapshot_diff > 0 OR v_charge_diff > 0 THEN
    RAISE EXCEPTION 'p6b1b-quote: % snapshots / % charge details still differ in the last 14 days', v_snapshot_diff, v_charge_diff;
  END IF;
  RAISE NOTICE 'p6b1b-quote: last 14 days of snapshots and charge details match their sources row by row';
END
$check$;
