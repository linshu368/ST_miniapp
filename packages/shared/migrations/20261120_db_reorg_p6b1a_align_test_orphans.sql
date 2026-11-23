-- Domain: billing（文本扣费）——数据库重组阶段 6b-1a 的 TEST 前置对齐（二）。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1a）。
--
-- 背景：20261120_db_reorg_p6b1a_align_test_charges.sql 之后，扩展文件在 TEST 重跑到"补无轮次的旧 key"时
--   撞了 usage_charges 的用户外键：去重表 billing.llm_usage_charge_dedup 没有用户外键，TEST 上有几条 key
--   属于已删除的用户。建表、镜像触发器、按轮次的回填已在 TEST 完成（每条语句单独提交），只有那一块回滚。
--   生产核对（11-20）：去重表、扣费记录、轮次里用户已不存在的都是 0。
-- 本文件：
--   - 去重表里没有"用户已不存在"的 key → 空操作（生产）；
--   - 有：先用 NOTICE 打出按状态 / 月份的汇总；只在 TEST（迁移账本里有只给 TEST 执行的文件）上删掉这些 key
--     （用户已删除，防重放已无意义）；非 TEST 直接拒绝。
-- 之后扩展文件按原校验和在 TEST 重跑。
--
-- Verify: bash scripts/test-db-reorg-p6b1a-align-test-orphans.sh
-- Release: TEST -> Production（生产为空操作，只为两边账本一致）。

DO $orphans$
DECLARE
  v_orphans bigint;
  v_deleted bigint;
  r record;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SELECT count(*) INTO v_orphans
  FROM billing.llm_usage_charge_dedup d
  WHERE NOT EXISTS (SELECT 1 FROM app_core.users u WHERE u.id = d.user_id);
  IF v_orphans = 0 THEN
    RAISE NOTICE 'p6b1a-orphans: no dedup keys of deleted users; nothing to do';
    RETURN;
  END IF;

  FOR r IN
    SELECT d.status, to_char(d.processed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month, count(*) AS n,
      sum(d.charged_amount) AS amount
    FROM billing.llm_usage_charge_dedup d
    WHERE NOT EXISTS (SELECT 1 FROM app_core.users u WHERE u.id = d.user_id)
    GROUP BY 1, 2 ORDER BY 2, 1
  LOOP
    RAISE NOTICE 'p6b1a-orphans: % % keys=% amount=%', r.month, r.status, r.n, r.amount;
  END LOOP;

  -- TEST 标记：只给 TEST 执行的迁移（apply 脚本禁止在生产执行它们）
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.repo_migrations
    WHERE filename = '20261026_checkin_tiered_rewards_test.sql'
       OR filename ~ '_media_plaza_(video_seed|stream)_test_'
  ) THEN
    RAISE EXCEPTION 'p6b1a-orphans: % dedup keys of deleted users on a database without TEST-only migrations; refusing', v_orphans;
  END IF;

  DELETE FROM billing.llm_usage_charge_dedup d
  WHERE NOT EXISTS (SELECT 1 FROM app_core.users u WHERE u.id = d.user_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'p6b1a-orphans: % TEST dedup keys of deleted users removed', v_deleted;
END
$orphans$;
