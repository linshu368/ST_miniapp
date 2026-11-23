-- Domain: billing（文本扣费）——数据库重组阶段 6b-1a 的 TEST 前置对齐。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1a）。
--
-- 背景：20261120_db_reorg_p6b1a_usage_charges_expand.sql 在 TEST 被前置守卫拦下：
--   26 轮的扣费记录金额与 chat_history.deduction_rate 不一致（TEST 有人手改过的数据；生产核对为 0）。
--   守卫在建表之前，TEST 上什么都没建。
-- 本文件：
--   - usage_charges 已存在，或没有不一致的轮次 → 空操作（生产）；
--   - 有不一致：先用 NOTICE 打出按月份 / 来源的汇总（含流水与哪一边一致）；
--     只在 TEST（迁移账本里有只给 TEST 执行的文件）上，把这些轮次的 deduction_rate 对齐为扣费记录金额；
--     非 TEST 直接拒绝，什么都不改。
-- 之后扩展文件按原校验和在 TEST 重跑。
--
-- Verify: bash scripts/test-db-reorg-p6b1a-align-test.sh
-- Release: TEST -> Production（生产为空操作，只为两边账本一致）。

DO $align$
DECLARE
  v_bad bigint;
  v_fixed bigint;
  r record;
BEGIN
  SET LOCAL lock_timeout = '5s';
  IF to_regclass('billing.usage_charges') IS NOT NULL THEN
    RAISE NOTICE 'p6b1a-align: usage_charges already exists; nothing to do';
    RETURN;
  END IF;

  SELECT count(*) INTO v_bad
  FROM experience.chat_history h
  LEFT JOIN billing.llm_usage_charges c ON c.charge_key = h.llm_charge_id
  LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key = h.llm_charge_id
  WHERE h.llm_charge_id IS NOT NULL AND h.created_at < now() - interval '10 minutes'
    AND COALESCE(c.charged_amount, d.charged_amount, h.deduction_rate, 0) IS DISTINCT FROM COALESCE(h.deduction_rate, 0);
  IF v_bad = 0 THEN
    RAISE NOTICE 'p6b1a-align: no mismatched turns; nothing to do';
    RETURN;
  END IF;

  FOR r IN
    SELECT to_char(h.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month,
      CASE WHEN c.charge_key IS NOT NULL THEN 'charge' ELSE 'dedup' END AS source,
      count(*) AS turns,
      count(*) FILTER (WHERE abs(l.amount) = COALESCE(c.charged_amount, d.charged_amount)) AS ledger_eq_charge,
      count(*) FILTER (WHERE abs(l.amount) = COALESCE(h.deduction_rate, 0)) AS ledger_eq_turn,
      count(*) FILTER (WHERE l.id IS NULL) AS no_ledger,
      sum(COALESCE(c.charged_amount, d.charged_amount) - COALESCE(h.deduction_rate, 0)) AS diff
    FROM experience.chat_history h
    LEFT JOIN billing.llm_usage_charges c ON c.charge_key = h.llm_charge_id
    LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key = h.llm_charge_id
    LEFT JOIN LATERAL (
      SELECT wl.id, wl.amount FROM billing.wallet_ledger wl
      WHERE wl.reference_type = 'llm_usage' AND wl.entry_type = 'chat_debit' AND wl.reference_id = h.llm_charge_id::text
      ORDER BY wl.created_at LIMIT 1) l ON true
    WHERE h.llm_charge_id IS NOT NULL AND h.created_at < now() - interval '10 minutes'
      AND COALESCE(c.charged_amount, d.charged_amount, h.deduction_rate, 0) IS DISTINCT FROM COALESCE(h.deduction_rate, 0)
    GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE 'p6b1a-align: % % turns=% ledger=charge:% ledger=turn:% no_ledger:% diff=%',
      r.month, r.source, r.turns, r.ledger_eq_charge, r.ledger_eq_turn, r.no_ledger, r.diff;
  END LOOP;

  -- TEST 标记：只给 TEST 执行的迁移（apply 脚本禁止在生产执行它们）
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.repo_migrations
    WHERE filename = '20261026_checkin_tiered_rewards_test.sql'
       OR filename ~ '_media_plaza_(video_seed|stream)_test_'
  ) THEN
    RAISE EXCEPTION 'p6b1a-align: % mismatched turns on a database without TEST-only migrations; refusing', v_bad;
  END IF;

  UPDATE experience.chat_history h
  SET deduction_rate = x.amount
  FROM (
    SELECT h2.id, COALESCE(c.charged_amount, d.charged_amount) AS amount
    FROM experience.chat_history h2
    LEFT JOIN billing.llm_usage_charges c ON c.charge_key = h2.llm_charge_id
    LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key = h2.llm_charge_id
    WHERE h2.llm_charge_id IS NOT NULL AND h2.created_at < now() - interval '10 minutes'
      AND COALESCE(c.charged_amount, d.charged_amount, h2.deduction_rate, 0) IS DISTINCT FROM COALESCE(h2.deduction_rate, 0)
  ) x
  WHERE h.id = x.id;
  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  SELECT count(*) INTO v_bad
  FROM experience.chat_history h
  LEFT JOIN billing.llm_usage_charges c ON c.charge_key = h.llm_charge_id
  LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key = h.llm_charge_id
  WHERE h.llm_charge_id IS NOT NULL AND h.created_at < now() - interval '10 minutes'
    AND COALESCE(c.charged_amount, d.charged_amount, h.deduction_rate, 0) IS DISTINCT FROM COALESCE(h.deduction_rate, 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'p6b1a-align: % turns still mismatched after alignment', v_bad;
  END IF;
  RAISE NOTICE 'p6b1a-align: % TEST turns aligned to their charge amount', v_fixed;
END
$align$;
