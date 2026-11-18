-- Domain: app_core（用户身份与资料、用户偏好）+ cs_feed（客服只读视图）+ admin（运营只读函数）。
-- 数据库重组阶段 3b-2（扩展步），规则见 docs/db/CONTRACT.md，计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3b-2。
--
-- 终态：
--   app_core.users            ← miniapp_user_settings 的资料列 tg_username / tg_first_name / tg_last_name /
--                                tg_avatar_url / display_name / custom_avatar_url（avatar_url 是无人读的旧 TG 头像链接，删除不迁）
--   app_core.user_preferences ← miniapp_user_settings 整表改名，只留偏好列（收缩步改名）
-- 本文件（扩展）：
--   1. users 加 6 个资料列并从 settings 回填；
--   2. 新函数 app_core.refresh_user_profile：TG 资料没变不写；
--   3. 同名自动可更新视图 app_core.user_preferences（只含偏好列，落到 settings），新后端从发布起就用最终名字；
--   4. cs_feed.user_identities、admin.list_invite_records、admin.lookup_user_for_credit_grant 改读 users（输出不变）；
--   5. 发布窗口资料双向同步：旧后端写 settings → users；新后端写 users → settings。
-- 收缩步（后端发布后）：20261117_db_reorg_p3b2_user_profile_contract.sql 删同步触发器与视图、表改名、删资料列、
--   4 个偏好函数改用新表名。
--
-- Verify: bash scripts/test-db-reorg-p3b2-migration.sh
-- Release: TEST -> Production -> 后端发布 -> 收缩步。
-- Recovery: settings 资料列仍在且双向同步；回退后端即可。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. users 资料列 -----------------------------------------------------------
ALTER TABLE app_core.users
  ADD COLUMN IF NOT EXISTS tg_username text,
  ADD COLUMN IF NOT EXISTS tg_first_name text,
  ADD COLUMN IF NOT EXISTS tg_last_name text,
  ADD COLUMN IF NOT EXISTS tg_avatar_url text,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS custom_avatar_url text;
COMMENT ON COLUMN app_core.users.tg_username IS 'Telegram username，认证请求时按 initData 刷新（app_core.refresh_user_profile）。';
COMMENT ON COLUMN app_core.users.tg_first_name IS 'Telegram first_name，认证请求时刷新。';
COMMENT ON COLUMN app_core.users.tg_last_name IS 'Telegram last_name，认证请求时刷新。';
COMMENT ON COLUMN app_core.users.tg_avatar_url IS 'Telegram initData 给的最新头像链接，认证请求时刷新。';
COMMENT ON COLUMN app_core.users.display_name IS '用户自定义昵称；生效名口径：display_name > tg_first_name > tg_username > 「你」。';
COMMENT ON COLUMN app_core.users.custom_avatar_url IS '用户导入的头像（平台托管 Supabase Storage），优先于 Telegram 头像。';

UPDATE app_core.users u SET
  tg_username = s.tg_username,
  tg_first_name = s.tg_first_name,
  tg_last_name = s.tg_last_name,
  tg_avatar_url = s.tg_avatar_url,
  display_name = s.display_name,
  custom_avatar_url = s.custom_avatar_url
FROM app_core.miniapp_user_settings s
WHERE s.user_id = u.id
  AND (u.tg_username, u.tg_first_name, u.tg_last_name, u.tg_avatar_url, u.display_name, u.custom_avatar_url)
      IS DISTINCT FROM (s.tg_username, s.tg_first_name, s.tg_last_name, s.tg_avatar_url, s.display_name, s.custom_avatar_url);

-- 2. TG 资料刷新 -------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_core.refresh_user_profile(
  p_user_id uuid, p_tg_username text, p_tg_first_name text, p_tg_last_name text, p_tg_avatar_url text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_profile jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  -- 每次认证请求都会调用；值没变就不写，避免在身份根表上堆无意义的行版本。
  UPDATE app_core.users u SET
    tg_username = p_tg_username,
    tg_first_name = p_tg_first_name,
    tg_last_name = p_tg_last_name,
    tg_avatar_url = p_tg_avatar_url,
    updated_at = now()
  WHERE u.id = p_user_id
    AND (u.tg_username, u.tg_first_name, u.tg_last_name, u.tg_avatar_url)
        IS DISTINCT FROM (p_tg_username, p_tg_first_name, p_tg_last_name, p_tg_avatar_url);
  SELECT jsonb_build_object(
    'tg_username', u.tg_username, 'tg_first_name', u.tg_first_name, 'tg_last_name', u.tg_last_name,
    'tg_avatar_url', u.tg_avatar_url, 'display_name', u.display_name, 'custom_avatar_url', u.custom_avatar_url,
    'updated_at', u.updated_at)
  INTO v_profile
  FROM app_core.users u WHERE u.id = p_user_id;
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_profile;
END;
$fn$;
COMMENT ON FUNCTION app_core.refresh_user_profile(uuid, text, text, text, text) IS
  '按 Telegram initData 刷新 users 的 TG 资料（值没变不写），返回当前资料。';
REVOKE ALL ON FUNCTION app_core.refresh_user_profile(uuid, text, text, text, text) FROM PUBLIC;
DO $fn_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION app_core.refresh_user_profile(uuid, text, text, text, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION app_core.refresh_user_profile(uuid, text, text, text, text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION app_core.refresh_user_profile(uuid, text, text, text, text) TO service_role;
  END IF;
END
$fn_acl$;

-- 3. 偏好视图（发布窗口用最终名字，收缩步换成改名后的表）--------------------------
DO $view$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'app_core' AND c.relname = 'user_preferences' AND c.relkind = 'r') THEN
    RETURN;  -- 收缩步已执行，表已改名
  END IF;
  CREATE OR REPLACE VIEW app_core.user_preferences WITH (security_invoker = true) AS
    SELECT s.user_id, s.selected_model_id, s.pref_word_count, s.pref_show_options, s.pref_show_status,
      s.pref_show_memory, s.pref_reply_styles, s.pref_drive_mode, s.pref_custom_instructions,
      s.pref_voice_id, s.pref_voice_playback_rate, s.created_at, s.updated_at
    FROM app_core.miniapp_user_settings s;
  COMMENT ON VIEW app_core.user_preferences IS
    '发布窗口（3b-2）：偏好列的同名可更新视图，落到 miniapp_user_settings。收缩步删视图并把表改成这个名字。';
  REVOKE ALL ON app_core.user_preferences FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON app_core.user_preferences FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON app_core.user_preferences FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON app_core.user_preferences TO service_role;
  END IF;
END
$view$;

-- 4. 读昵称的视图与运营函数改读 users ------------------------------------------
-- CREATE OR REPLACE 会重置视图选项，security_barrier 必须显式带上（授权与注释会保留）。
CREATE OR REPLACE VIEW cs_feed.user_identities WITH (security_barrier = true) AS
  SELECT u.id AS user_id,
    u.tg_id,
    COALESCE(NULLIF(u.display_name, ''::text), NULLIF(u.tg_username, ''::text), NULLIF(u.tg_first_name, ''::text)) AS display_name,
    NULLIF(u.tg_username, ''::text) AS username
  FROM app_core.users u;

-- 只换 join 的表，别名不变，函数体其余部分原样保留（按原文定位，次数不符就拒绝）。
DO $admin$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('admin.lookup_user_for_credit_grant(text)', 1,
       'LEFT JOIN app_core.miniapp_user_settings AS settings ON settings.user_id = v_user.id',
       'LEFT JOIN app_core.users AS settings ON settings.id = v_user.id', NULL::text, NULL::text),
      ('admin.list_invite_records(text,text,timestamp with time zone,timestamp with time zone,text,integer,integer)', 2,
       'LEFT JOIN app_core.miniapp_user_settings AS si ON si.user_id = r.inviter_user_id',
       'LEFT JOIN app_core.users AS si ON si.id = r.inviter_user_id',
       'LEFT JOIN app_core.miniapp_user_settings AS sv ON sv.user_id = r.invitee_user_id',
       'LEFT JOIN app_core.users AS sv ON sv.id = r.invitee_user_id')
    ) AS t(fn, joins, old1, new1, old2, new2)
  LOOP
    IF to_regprocedure(r.fn) IS NULL THEN
      RAISE NOTICE '% not present; skipped', r.fn;
      CONTINUE;
    END IF;
    v_def := replace(pg_get_functiondef(to_regprocedure(r.fn)), E'\r', '');
    IF position('miniapp_user_settings' IN v_def) = 0 THEN
      CONTINUE;  -- 已改（重跑）
    END IF;
    v_new := replace(v_def, r.old1, r.new1);
    IF r.old2 IS NOT NULL THEN v_new := replace(v_new, r.old2, r.new2); END IF;
    IF position('miniapp_user_settings' IN v_new) > 0
       OR (length(v_def) - length(replace(v_def, 'app_core.miniapp_user_settings', ''))) / length('app_core.miniapp_user_settings') <> r.joins THEN
      RAISE EXCEPTION '% joins miniapp_user_settings in an unexpected way; refusing to rewrite', r.fn;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$admin$;

-- 5. 发布窗口资料双向同步（收缩步删除）--------------------------------------------
-- 不变式：窗口内每个 settings 行的资料与 users 一致，收缩步才能放心"按 settings 补 users"。
-- 新建 settings 行（新后端经视图建偏好行、开轮函数、回复风格函数）不带资料，先从 users 填上。
CREATE OR REPLACE FUNCTION app_core.tf_fill_settings_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v app_core.users%ROWTYPE;
BEGIN
  SELECT * INTO v FROM app_core.users WHERE id = NEW.user_id;
  NEW.tg_username := COALESCE(NEW.tg_username, v.tg_username);
  NEW.tg_first_name := COALESCE(NEW.tg_first_name, v.tg_first_name);
  NEW.tg_last_name := COALESCE(NEW.tg_last_name, v.tg_last_name);
  NEW.tg_avatar_url := COALESCE(NEW.tg_avatar_url, v.tg_avatar_url);
  NEW.display_name := COALESCE(NEW.display_name, v.display_name);
  NEW.custom_avatar_url := COALESCE(NEW.custom_avatar_url, v.custom_avatar_url);
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS settings_fill_profile ON app_core.miniapp_user_settings;
CREATE TRIGGER settings_fill_profile
  BEFORE INSERT ON app_core.miniapp_user_settings
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_fill_settings_profile();
REVOKE ALL ON FUNCTION app_core.tf_fill_settings_profile() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_core.tf_sync_settings_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    -- 新建设置行只带非空值，避免空值盖掉新后端已写进 users 的资料。
    UPDATE app_core.users u SET
      tg_username = COALESCE(NEW.tg_username, u.tg_username),
      tg_first_name = COALESCE(NEW.tg_first_name, u.tg_first_name),
      tg_last_name = COALESCE(NEW.tg_last_name, u.tg_last_name),
      tg_avatar_url = COALESCE(NEW.tg_avatar_url, u.tg_avatar_url),
      display_name = COALESCE(NEW.display_name, u.display_name),
      custom_avatar_url = COALESCE(NEW.custom_avatar_url, u.custom_avatar_url)
    WHERE u.id = NEW.user_id
      AND (NEW.tg_username, NEW.tg_first_name, NEW.tg_last_name, NEW.tg_avatar_url, NEW.display_name, NEW.custom_avatar_url)
          IS DISTINCT FROM (NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text);
    RETURN NULL;
  END IF;
  -- UPDATE：只带变化的列（含改成空，例如清掉自定义头像）。
  UPDATE app_core.users u SET
    tg_username = CASE WHEN NEW.tg_username IS DISTINCT FROM OLD.tg_username THEN NEW.tg_username ELSE u.tg_username END,
    tg_first_name = CASE WHEN NEW.tg_first_name IS DISTINCT FROM OLD.tg_first_name THEN NEW.tg_first_name ELSE u.tg_first_name END,
    tg_last_name = CASE WHEN NEW.tg_last_name IS DISTINCT FROM OLD.tg_last_name THEN NEW.tg_last_name ELSE u.tg_last_name END,
    tg_avatar_url = CASE WHEN NEW.tg_avatar_url IS DISTINCT FROM OLD.tg_avatar_url THEN NEW.tg_avatar_url ELSE u.tg_avatar_url END,
    display_name = CASE WHEN NEW.display_name IS DISTINCT FROM OLD.display_name THEN NEW.display_name ELSE u.display_name END,
    custom_avatar_url = CASE WHEN NEW.custom_avatar_url IS DISTINCT FROM OLD.custom_avatar_url THEN NEW.custom_avatar_url ELSE u.custom_avatar_url END
  WHERE u.id = NEW.user_id
    AND (NEW.tg_username, NEW.tg_first_name, NEW.tg_last_name, NEW.tg_avatar_url, NEW.display_name, NEW.custom_avatar_url)
        IS DISTINCT FROM (OLD.tg_username, OLD.tg_first_name, OLD.tg_last_name, OLD.tg_avatar_url, OLD.display_name, OLD.custom_avatar_url);
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS settings_sync_profile ON app_core.miniapp_user_settings;
CREATE TRIGGER settings_sync_profile
  AFTER INSERT OR UPDATE OF tg_username, tg_first_name, tg_last_name, tg_avatar_url, display_name, custom_avatar_url
  ON app_core.miniapp_user_settings
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_sync_settings_profile();

CREATE OR REPLACE FUNCTION app_core.tf_sync_users_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  UPDATE app_core.miniapp_user_settings s SET
    tg_username = CASE WHEN NEW.tg_username IS DISTINCT FROM OLD.tg_username THEN NEW.tg_username ELSE s.tg_username END,
    tg_first_name = CASE WHEN NEW.tg_first_name IS DISTINCT FROM OLD.tg_first_name THEN NEW.tg_first_name ELSE s.tg_first_name END,
    tg_last_name = CASE WHEN NEW.tg_last_name IS DISTINCT FROM OLD.tg_last_name THEN NEW.tg_last_name ELSE s.tg_last_name END,
    tg_avatar_url = CASE WHEN NEW.tg_avatar_url IS DISTINCT FROM OLD.tg_avatar_url THEN NEW.tg_avatar_url ELSE s.tg_avatar_url END,
    display_name = CASE WHEN NEW.display_name IS DISTINCT FROM OLD.display_name THEN NEW.display_name ELSE s.display_name END,
    custom_avatar_url = CASE WHEN NEW.custom_avatar_url IS DISTINCT FROM OLD.custom_avatar_url THEN NEW.custom_avatar_url ELSE s.custom_avatar_url END
  WHERE s.user_id = NEW.id
    AND (NEW.tg_username, NEW.tg_first_name, NEW.tg_last_name, NEW.tg_avatar_url, NEW.display_name, NEW.custom_avatar_url)
        IS DISTINCT FROM (OLD.tg_username, OLD.tg_first_name, OLD.tg_last_name, OLD.tg_avatar_url, OLD.display_name, OLD.custom_avatar_url);
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS users_sync_profile ON app_core.users;
CREATE TRIGGER users_sync_profile
  AFTER UPDATE OF tg_username, tg_first_name, tg_last_name, tg_avatar_url, display_name, custom_avatar_url
  ON app_core.users
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_sync_users_profile();
REVOKE ALL ON FUNCTION app_core.tf_sync_settings_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_core.tf_sync_users_profile() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
COMMIT;
