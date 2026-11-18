-- Domain: app_core（用户偏好）——3b-1 收缩前置：清掉没有返利记录的"首发分享完成时间"。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3b-1。
--
-- 背景：TEST 执行 20261117_db_reorg_p3b1_user_marks_contract.sql 时守卫报
--   "first share completed without a share reward record"。share_image_plaza_artifact 自第一版（20261012）起
--   就在同一事务里同时写返利记录和这个时间，代码里也没有删返利记录的路径；这类行只可能来自手工改测试数据。
--   生产 11-17 核对为 0 行（7 人与返利记录完全一致），本文件在生产为空操作。
-- 3b-1 起"已完成首发分享"的定义就是"有返利记录"，孤立的时间按新定义清空（只影响测试账号会再看到一次首发提示）。
--
-- Verify: bash scripts/test-db-reorg-p3b1-migration.sh。
-- Release: TEST -> Production（生产执行前复核孤立行为 0）。
-- Recovery: 只影响 UI 提示，无需恢复。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $orphan$
DECLARE
  v_cleared integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app_core' AND table_name = 'miniapp_user_settings'
               AND column_name = 'image_plaza_first_share_completed_at') THEN
    UPDATE app_core.miniapp_user_settings s
    SET image_plaza_first_share_completed_at = NULL
    WHERE s.image_plaza_first_share_completed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM billing.image_plaza_share_rewards r WHERE r.user_id = s.user_id);
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;
  RAISE NOTICE 'cleared % first-share marks without a share reward record', v_cleared;
END
$orphan$;

COMMIT;
