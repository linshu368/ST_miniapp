-- Domain: miniapp_analytics——删除只存在于 TEST 的遗留视图 funnel_stats，给 3a 收缩步删 users 列让路。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3a。
--
-- 背景：TEST 执行 20261117_db_reorg_p3a_user_attributions_contract.sql 时报
--   "view miniapp_analytics.funnel_stats depends on column bot_entered_at of table app_core.users"。
--   该视图来自早期手工建表，生产没有（11-17 核对），仓库代码无读者，只出现在 2026-08 的结构快照里。
-- 生产执行为空操作；同时复核：删完后若仍有视图依赖 users / settings 上要删的列，整体回滚并列出全部对象。
--
-- Verify: bash scripts/test-db-reorg-p3a-migration.sh。
-- Release: TEST -> Production（生产为空操作，只为两边账本一致）。
-- Recovery: 无读者，无需恢复；确需时按 2026-08 快照里的定义重建。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP VIEW IF EXISTS miniapp_analytics.funnel_stats;

DO $deps$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(DISTINCT v.oid::regclass::text || '(' || a.attname || ')', ', ') INTO v_left
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class v ON v.oid = r.ev_class
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.classid = 'pg_rewrite'::regclass
    AND d.refobjid IN ('app_core.users'::regclass, 'app_core.miniapp_user_settings'::regclass)
    AND v.oid <> d.refobjid
    AND ((d.refobjid = 'app_core.users'::regclass
          AND a.attname IN ('source_id', 'bot_entered_at', 'miniapp_entered_at', 'total_round', 'st_initialized_at'))
      OR (d.refobjid = 'app_core.miniapp_user_settings'::regclass AND a.attname = 'total_round'));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'views still depend on columns 3a contract drops: %', v_left;
  END IF;
END
$deps$;

COMMIT;
