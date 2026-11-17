-- Domain: billing（媒体广场分享）——3b-1 收缩前置：视频分享函数不再写 settings 的首发分享时间。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3b-1。
--
-- 背景：TEST 执行 20261117_db_reorg_p3b1_user_marks_contract.sql 时守卫报
--   "functions still read moved settings columns: billing.share_media_plaza_video(...)"。
--   该函数来自未合并的视频广场分支（PR #566，20261027_media_plaza_video.sql），只在 TEST 执行过，生产没有。
--   它和图片分享一样，在同一事务里先写 billing.image_plaza_share_rewards 再写 settings 首发时间；
--   3b-1 起"已完成首发分享"= 有返利记录，所以只需去掉写 settings 的那段，行为不变。
-- 做法与收缩步改 share_image_plaza_artifact 相同：按原文定位，删掉的文本必须与预期语句完全一致，否则拒绝。
-- 生产：函数不存在，空操作。视频分支上线前需在其迁移后补同样的改动（legacy 守卫规则 moved-to-user-marks 会提示）。
--
-- Verify: bash scripts/test-db-reorg-p3b1-migration.sh。
-- Release: TEST -> Production（生产为空操作，只为两边账本一致）。
-- Recovery: 只去掉一段写已废弃列的语句；如需恢复，重放 20261027_media_plaza_video.sql 中该函数定义。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $video$
DECLARE
  v_fn regprocedure := to_regprocedure('billing.share_media_plaza_video(uuid,uuid,text,text,text,text[],numeric)');
  v_def text;
  v_start integer;
  v_len integer;
  v_removed text;
  c_head constant text := 'INSERT INTO app_core.miniapp_user_settings(user_id, image_plaza_first_share_completed_at)';
  c_tail constant text := 'updated_at = now();';
BEGIN
  IF v_fn IS NULL THEN
    RAISE NOTICE 'billing.share_media_plaza_video not present; nothing to do';
    RETURN;
  END IF;
  v_def := replace(pg_get_functiondef(v_fn), E'\r', '');
  IF position('miniapp_user_settings' IN v_def) = 0 THEN
    RETURN;  -- 已去掉（重跑）
  END IF;
  v_start := position(c_head IN v_def);
  IF v_start = 0 THEN
    RAISE EXCEPTION 'share_media_plaza_video references miniapp_user_settings in an unexpected way';
  END IF;
  v_len := position(c_tail IN substr(v_def, v_start)) + length(c_tail) - 1;
  v_removed := substr(v_def, v_start, v_len);
  IF v_removed !~ ('^INSERT INTO app_core\.miniapp_user_settings\(user_id, image_plaza_first_share_completed_at\)\s+'
                   'VALUES \(p_user_id, now\(\)\)\s+ON CONFLICT \(user_id\) DO UPDATE\s+'
                   'SET image_plaza_first_share_completed_at = COALESCE\(\s+'
                   'app_core\.miniapp_user_settings\.image_plaza_first_share_completed_at,\s+'
                   'EXCLUDED\.image_plaza_first_share_completed_at\s*\),\s+updated_at = now\(\);$') THEN
    RAISE EXCEPTION 'share_media_plaza_video settings upsert changed; refusing to rewrite: %', v_removed;
  END IF;
  v_def := substr(v_def, 1, v_start - 1) || '-- 首发分享由 billing.image_plaza_share_rewards 是否有记录推导（3b-1）。'
           || substr(v_def, v_start + v_len);
  IF position('miniapp_user_settings' IN v_def) > 0 THEN
    RAISE EXCEPTION 'share_media_plaza_video still references miniapp_user_settings after rewrite';
  END IF;
  EXECUTE v_def;
END
$video$;

COMMIT;
