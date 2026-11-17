-- Domain: app_core（用户身份）——阶段 3a 收缩步：删发布窗口兼容对象与 users 上已搬走的列。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3a。
--
-- 前置：20261117_db_reorg_p3a_user_attributions.sql 已执行；生产后端已改用 miniapp_traffic.enter_user、
-- experience.increment_user_total_round，并核对旧列不再被写（见 design.md 核对步骤）。
-- 删除：触发器 users_sync_attribution 及其函数、兼容函数 app_core.increment_user_total_round；
--   app_core.users 的 source_id / bot_entered_at / miniapp_entered_at / total_round / st_initialized_at；
--   app_core.miniapp_user_settings.total_round（重复计数，无读者）。
-- 补齐：扩展迁移执行期间旧后端仍在写，回填快照之后、兼容函数替换之前提交的写入只落在 users
--   （生产 11-17 实测 1 个用户差 1 轮）。删列前在锁内按扩展迁移同一规则再补一次：归因只补空值，轮数取大。
-- 守卫：补齐后仍有缺口，或仍有函数引用旧列时拒绝。
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
  -- 只有 users 还有这些列时才需要补齐与核对（可重跑）。
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app_core' AND table_name = 'users' AND column_name = 'total_round') THEN
    -- 后面 DROP COLUMN 本来就要 ACCESS EXCLUSIVE，提前拿锁，避免补齐与删列之间再有写入漏掉。
    LOCK TABLE app_core.users IN ACCESS EXCLUSIVE MODE;

    INSERT INTO miniapp_traffic.user_attributions AS ua
      (user_id, source_id, bot_entered_at, miniapp_entered_at, st_initialized_at, created_at, updated_at)
    SELECT u.id, u.source_id, u.bot_entered_at, u.miniapp_entered_at,
      (to_jsonb(u) ->> 'st_initialized_at')::timestamptz, u.created_at, u.updated_at
    FROM app_core.users u
    ON CONFLICT (user_id) DO UPDATE SET
      source_id = COALESCE(ua.source_id, EXCLUDED.source_id),
      bot_entered_at = COALESCE(ua.bot_entered_at, EXCLUDED.bot_entered_at),
      miniapp_entered_at = COALESCE(ua.miniapp_entered_at, EXCLUDED.miniapp_entered_at),
      st_initialized_at = COALESCE(ua.st_initialized_at, EXCLUDED.st_initialized_at),
      updated_at = now()
    WHERE (ua.source_id IS NULL AND EXCLUDED.source_id IS NOT NULL)
       OR (ua.bot_entered_at IS NULL AND EXCLUDED.bot_entered_at IS NOT NULL)
       OR (ua.miniapp_entered_at IS NULL AND EXCLUDED.miniapp_entered_at IS NOT NULL)
       OR (ua.st_initialized_at IS NULL AND EXCLUDED.st_initialized_at IS NOT NULL);

    INSERT INTO experience.user_chat_stats AS st (user_id, total_round, updated_at)
    SELECT u.id, u.total_round, now() FROM app_core.users u WHERE u.total_round > 0
    ON CONFLICT (user_id) DO UPDATE SET total_round = EXCLUDED.total_round, updated_at = now()
    WHERE st.total_round < EXCLUDED.total_round;

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
