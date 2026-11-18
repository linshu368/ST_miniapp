-- Domain: app_core（用户身份与资料、用户偏好）——阶段 3b-2 收缩步。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3b-2。
--
-- 前置：20261117_db_reorg_p3b2_user_profile.sql 已执行；生产后端已改为资料读写 users、偏好读写 app_core.user_preferences，
--   并核对旧写法停涨（见 design.md 核对步骤）。
-- 步骤（同一事务）：
--   1. 锁 settings，删两个资料同步触发器；资料不一致的列按 settings 补到 users（只可能来自扩展事务里的竞态）；
--   2. 守卫：除 4 个偏好函数外，不得再有函数或视图引用 app_core.miniapp_user_settings；
--   3. 删同名视图 → 表改名 app_core.user_preferences（约束随之改名）→ 删 7 个资料列（含无人读的 avatar_url）；
--   4. 4 个偏好函数把 app_core.miniapp_user_settings 全部换成 app_core.user_preferences
--      （都是同一张表的全限定名，全部替换即正确；替换后不得残留未限定的旧名）。
--
-- Verify: bash scripts/test-db-reorg-p3b2-migration.sh（末段）。
-- Release: TEST -> Production。
-- Recovery: 不可逆；资料已在 users。必要时把表改回原名、加回资料列并从 users 回填。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $contract$
DECLARE
  v_n integer;
  v_ref text;
  r record;
  v_def text;
  c_old constant text := 'app_core.miniapp_user_settings';
  c_new constant text := 'app_core.user_preferences';
BEGIN
  IF to_regclass('app_core.miniapp_user_settings') IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'app_core' AND c.relname = 'user_preferences' AND c.relkind = 'r') THEN
      RAISE EXCEPTION 'neither app_core.miniapp_user_settings nor table app_core.user_preferences exists';
    END IF;
    RETURN;  -- 已收缩（重跑）
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'app_core' AND table_name = 'users' AND column_name = 'display_name') THEN
    RAISE EXCEPTION 'apply 20261117_db_reorg_p3b2_user_profile.sql first';
  END IF;

  -- 1. 停同步、补齐 --------------------------------------------------------
  LOCK TABLE app_core.miniapp_user_settings IN ACCESS EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS settings_fill_profile ON app_core.miniapp_user_settings;
  DROP TRIGGER IF EXISTS settings_sync_profile ON app_core.miniapp_user_settings;
  DROP TRIGGER IF EXISTS users_sync_profile ON app_core.users;
  DROP FUNCTION IF EXISTS app_core.tf_fill_settings_profile();
  DROP FUNCTION IF EXISTS app_core.tf_sync_settings_profile();
  DROP FUNCTION IF EXISTS app_core.tf_sync_users_profile();

  UPDATE app_core.users u SET
    tg_username = s.tg_username,
    tg_first_name = s.tg_first_name,
    tg_last_name = s.tg_last_name,
    tg_avatar_url = s.tg_avatar_url,
    display_name = s.display_name,
    custom_avatar_url = s.custom_avatar_url,
    updated_at = now()
  FROM app_core.miniapp_user_settings s
  WHERE s.user_id = u.id
    AND (u.tg_username, u.tg_first_name, u.tg_last_name, u.tg_avatar_url, u.display_name, u.custom_avatar_url)
        IS DISTINCT FROM (s.tg_username, s.tg_first_name, s.tg_last_name, s.tg_avatar_url, s.display_name, s.custom_avatar_url);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'reconciled % user profiles from settings', v_n;

  -- 2. 守卫 ----------------------------------------------------------------
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosrc ~ 'miniapp_user_settings'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.oid NOT IN (
      SELECT to_regprocedure(f) FROM unnest(ARRAY[
        'app_core.update_instruction_slot_preferences(uuid,boolean,boolean,boolean)',
        'app_core.update_reply_style_preferences(uuid,jsonb)',
        'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
        'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'
      ]) AS f WHERE to_regprocedure(f) IS NOT NULL);
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'functions still reference app_core.miniapp_user_settings: %', v_ref;
  END IF;
  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_ref
  FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
  WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'app_core.miniapp_user_settings'::regclass
    AND v.oid <> d.refobjid AND v.oid IS DISTINCT FROM to_regclass('app_core.user_preferences');
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'views still depend on app_core.miniapp_user_settings: %', v_ref;
  END IF;

  -- 3. 视图换表、改名、删资料列 -----------------------------------------------
  DROP VIEW IF EXISTS app_core.user_preferences;
  ALTER TABLE app_core.miniapp_user_settings RENAME TO user_preferences;
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'app_core.user_preferences'::regclass AND conname LIKE 'miniapp\_user\_settings\_%'
  LOOP
    EXECUTE format('ALTER TABLE app_core.user_preferences RENAME CONSTRAINT %I TO %I',
      r.conname, 'user_preferences_' || substr(r.conname, length('miniapp_user_settings_') + 1));
  END LOOP;
  FOR r IN
    SELECT i.indexrelid::regclass AS idx, c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'app_core.user_preferences'::regclass AND c.relname LIKE 'miniapp\_user\_settings\_%'
  LOOP
    EXECUTE format('ALTER INDEX %s RENAME TO %I', r.idx,
      'user_preferences_' || substr(r.relname, length('miniapp_user_settings_') + 1));
  END LOOP;
  ALTER TABLE app_core.user_preferences
    DROP COLUMN IF EXISTS tg_username,
    DROP COLUMN IF EXISTS tg_first_name,
    DROP COLUMN IF EXISTS tg_last_name,
    DROP COLUMN IF EXISTS tg_avatar_url,
    DROP COLUMN IF EXISTS display_name,
    DROP COLUMN IF EXISTS custom_avatar_url,
    DROP COLUMN IF EXISTS avatar_url;
  COMMENT ON TABLE app_core.user_preferences IS
    '用户级生成与语音偏好（每用户一行，无行=全部默认）。资料在 app_core.users，一次性标记在 miniapp_features.user_marks。';

  -- 4. 偏好函数换表名 --------------------------------------------------------
  FOR r IN
    SELECT to_regprocedure(f) AS fn FROM unnest(ARRAY[
      'app_core.update_instruction_slot_preferences(uuid,boolean,boolean,boolean)',
      'app_core.update_reply_style_preferences(uuid,jsonb)',
      'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
      'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'
    ]) AS f WHERE to_regprocedure(f) IS NOT NULL
  LOOP
    v_def := replace(pg_get_functiondef(r.fn), E'\r', '');
    IF position(c_old IN v_def) = 0 THEN
      CONTINUE;
    END IF;
    v_def := replace(v_def, c_old, c_new);
    IF position('miniapp_user_settings' IN v_def) > 0 THEN
      RAISE EXCEPTION '% references miniapp_user_settings without the app_core qualifier; refusing to rewrite', r.fn;
    END IF;
    EXECUTE v_def;
  END LOOP;
END
$contract$;

NOTIFY pgrst, 'reload schema';
COMMIT;
