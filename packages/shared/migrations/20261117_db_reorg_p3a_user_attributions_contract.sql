-- Domain: app_core（用户身份）——阶段 3a 收缩步：删发布窗口兼容对象与 users 上已搬走的列。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3a。
--
-- 前置：20261117_db_reorg_p3a_user_attributions.sql 已执行；生产后端已改用 miniapp_traffic.enter_user、
-- experience.increment_user_total_round，并核对旧列不再被写（见 design.md 核对步骤）。
-- 删除：触发器 users_sync_attribution 及其函数、兼容函数 app_core.increment_user_total_round；
--   app_core.users 的 source_id / bot_entered_at / miniapp_entered_at / total_round / st_initialized_at；
--   app_core.miniapp_user_settings.total_round（重复计数，无读者）。
-- 守卫：新表缺行（users 有、归因表无）或仍有函数/视图引用旧列时拒绝。
--
-- Verify: bash scripts/test-db-reorg-p3a-migration.sh（末段）。
-- Release: TEST -> Production。
-- Recovery: 不可逆；数据已在新表，必要时可从新表加回列并回填。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v_ref text;
BEGIN
  IF to_regclass('miniapp_traffic.user_attributions') IS NULL OR to_regclass('experience.user_chat_stats') IS NULL THEN
    RAISE EXCEPTION 'apply 20261117_db_reorg_p3a_user_attributions.sql first';
  END IF;
  -- 只有 users 还有这些列时才需要核对（可重跑）。
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app_core' AND table_name = 'users' AND column_name = 'total_round') THEN
    IF EXISTS (SELECT 1 FROM app_core.users u
               LEFT JOIN miniapp_traffic.user_attributions a ON a.user_id = u.id
               WHERE a.user_id IS NULL
                  OR (u.source_id IS NOT NULL AND a.source_id IS NULL)
                  OR (u.bot_entered_at IS NOT NULL AND a.bot_entered_at IS NULL)
                  OR (u.miniapp_entered_at IS NOT NULL AND a.miniapp_entered_at IS NULL)) THEN
      RAISE EXCEPTION 'user_attributions is missing values still present on app_core.users';
    END IF;
    IF EXISTS (SELECT 1 FROM app_core.users u WHERE u.total_round > experience.user_total_round(u.id)) THEN
      RAISE EXCEPTION 'user_chat_stats is behind app_core.users.total_round';
    END IF;
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosrc ~ '\m(u|users)\.(source_id|bot_entered_at|miniapp_entered_at|total_round|st_initialized_at)\M'
    AND p.prosrc ~ 'app_core\.users'
    AND NOT (n.nspname = 'app_core' AND p.proname IN ('increment_user_total_round', 'tf_sync_user_attribution'));
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'functions still read moved users columns: %', v_ref; END IF;
END
$guard$;

DROP TRIGGER IF EXISTS users_sync_attribution ON app_core.users;
DROP FUNCTION IF EXISTS app_core.tf_sync_user_attribution();
DROP FUNCTION IF EXISTS app_core.increment_user_total_round(uuid, integer);

ALTER TABLE app_core.users
  DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS bot_entered_at,
  DROP COLUMN IF EXISTS miniapp_entered_at,
  DROP COLUMN IF EXISTS total_round,
  DROP COLUMN IF EXISTS st_initialized_at;
ALTER TABLE app_core.miniapp_user_settings DROP COLUMN IF EXISTS total_round;

NOTIFY pgrst, 'reload schema';
COMMIT;
