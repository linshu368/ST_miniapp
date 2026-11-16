-- Domain: app_core（用户长期偏好 miniapp_user_settings.pref_drive_mode）
--         + admin managed config key `drive_mode_options`.
--
-- 剧情模式：用户在回复偏好里选择“剧情由谁推动”（我来带 / 等 TA 撩 / 来点意外 / 替我演）。
--   1) app_core.miniapp_user_settings.pref_drive_mode：用户选择的档位 id，NULL = 跟随默认档。
--      唯一写入方：后端生成偏好 PATCH（只接受当前启用的档位）；读方：生成链路与偏好接口。
--   2) drive_mode_options 运营 managed key：各档名称、说明、注入规则与默认档。
--      字段规则在 shared zod（DriveModesConfigSchema）；库里只保证是 JSON 对象，防止畸形发布落库。
-- 每轮实际使用的档位写在 experience.chat_history.rich_reply_metadata.drive_mode（既有 CHECK
-- 允许附加键），不改热表结构。
--
-- 新列可空、无默认值，ADD COLUMN 只改目录，不重写表；CHECK 校验扫描现有行（全部为 NULL）。
-- 执行顺序：TEST → 生产；先迁移、再部署后端与前端（配置缺失时前端隐藏栏目、引擎注入保守规则），
--   最后发布 drive_mode_options、新主体模板与回复风格。
-- 回滚：先在运营平台回滚主体模板并停用剧情模式；如需删除对象，
--   ALTER TABLE app_core.miniapp_user_settings DROP COLUMN pref_drive_mode;
--   managed key 的函数链保留（对未知 key 仍然拒绝），不影响其他配置。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.miniapp_user_settings') IS NULL
     OR to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'drive mode: prerequisite objects missing';
  END IF;
  IF (to_regprocedure('admin.is_managed_config_key_before_drive_mode(text)') IS NULL)
     <> (to_regprocedure('admin.validate_managed_config_value_before_drive_mode(text,jsonb,text)') IS NULL) THEN
    RAISE EXCEPTION 'drive mode: inconsistent wrapper predecessor state';
  END IF;
END
$preflight$;

-- ── 1. 用户偏好 ─────────────────────────────────────────────────────────────

ALTER TABLE app_core.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS pref_drive_mode text;

DO $preference_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'app_core.miniapp_user_settings'::regclass
      AND a.attname = 'pref_drive_mode' AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef
  ) THEN
    RAISE EXCEPTION 'drive mode: unexpected preference column shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname = 'miniapp_user_settings_pref_drive_mode_check'
  ) THEN
    -- 与 shared DriveModeIdSchema 同一形状；是否属于当前启用档位由后端在写入时校验。
    ALTER TABLE app_core.miniapp_user_settings
      ADD CONSTRAINT miniapp_user_settings_pref_drive_mode_check
      CHECK (pref_drive_mode IS NULL OR pref_drive_mode ~ '^[a-z][a-z0-9-]{0,31}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname = 'miniapp_user_settings_pref_drive_mode_check'
      AND contype = 'c' AND convalidated
  ) THEN
    RAISE EXCEPTION 'drive mode: preference CHECK missing or unvalidated';
  END IF;
END
$preference_shape$;

-- ── 2. 运营 managed key ──────────────────────────────────────────────────────

DO $extend_functions$
DECLARE
  v_signature text;
  v_predecessor text;
  v_original_acl aclitem[];
  v_acl record;
  v_role text;
  v_new_functions text[] := ARRAY[]::text[];
BEGIN
  IF to_regprocedure('admin.is_managed_config_key_before_drive_mode(text)') IS NULL THEN
    ALTER FUNCTION admin.is_managed_config_key(text) RENAME TO is_managed_config_key_before_drive_mode;
    EXECUTE $ddl$CREATE FUNCTION admin.is_managed_config_key(p_config_key text)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $body$
      SELECT p_config_key = 'drive_mode_options'
        OR admin.is_managed_config_key_before_drive_mode(p_config_key)
    $body$$ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.is_managed_config_key(text)');
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_drive_mode(text,jsonb,text)') IS NULL THEN
    ALTER FUNCTION admin.validate_managed_config_value(text,jsonb,text)
      RENAME TO validate_managed_config_value_before_drive_mode;
    EXECUTE $ddl$CREATE FUNCTION admin.validate_managed_config_value(
      p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL
    ) RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $body$
    BEGIN
      -- 字段规则在 shared zod；库里只保证存的是带 modes 数组的 JSON 对象。
      IF p_config_key = 'drive_mode_options' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
           OR jsonb_typeof(p_value -> 'modes') IS DISTINCT FROM 'array'
           OR jsonb_typeof(p_value -> 'default_mode_id') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'drive mode options require a JSON object with modes and default_mode_id'
            USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_drive_mode(p_config_key, p_value, p_text_value);
    END $body$$ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.validate_managed_config_value(text,jsonb,text)');
  END IF;
  -- 新函数沿用被改名的前任函数的 EXECUTE 权限，不自己发明新权限。
  FOREACH v_signature IN ARRAY v_new_functions LOOP
    v_predecessor := CASE v_signature
      WHEN 'admin.is_managed_config_key(text)'
        THEN 'admin.is_managed_config_key_before_drive_mode(text)'
      ELSE 'admin.validate_managed_config_value_before_drive_mode(text,jsonb,text)'
    END;
    SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_original_acl
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_predecessor);
    FOR v_acl IN
      SELECT DISTINCT acl.grantee
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.oid = to_regprocedure(v_signature)
    LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_signature, v_role);
    END LOOP;
    FOR v_acl IN SELECT * FROM aclexplode(v_original_acl) LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', v_signature, v_role,
        CASE WHEN v_acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END
$extend_functions$;

DO $widen_checks$
DECLARE
  v_table regclass;
  v_name text;
  v_expression text;
  v_validated boolean;
  v_allowed boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::regclass, 'admin.config_releases'::regclass
  ] LOOP
    v_name := CASE v_table
      WHEN 'admin.config_drafts'::regclass THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_expr(c.conbin, c.conrelid), c.convalidated
      INTO v_expression, v_validated
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'drive mode: missing constraint %.%', v_table, v_name;
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING 'drive_mode_options';
    IF v_allowed IS DISTINCT FROM true THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
        v_table, v_name, v_expression,
        CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
      );
      SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_expression
      FROM pg_constraint c
      WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING 'drive_mode_options';
    IF v_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'drive mode: key rejected by %', v_table;
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING '__unknown_config_key__';
    IF v_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'drive mode: unknown key accepted by %', v_table;
    END IF;
  END LOOP;
END
$widen_checks$;

DO $selfcheck$
BEGIN
  IF NOT admin.is_managed_config_key('drive_mode_options')
     OR admin.is_managed_config_key('__unknown_config_key__') THEN
    RAISE EXCEPTION 'drive mode: managed key self-check failed';
  END IF;
  BEGIN
    PERFORM admin.validate_managed_config_value('drive_mode_options', '[]'::jsonb, NULL);
    RAISE EXCEPTION 'drive mode: validator accepted a non-object';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  PERFORM admin.validate_managed_config_value(
    'drive_mode_options', '{"modes": [], "default_mode_id": "active"}'::jsonb, NULL
  );
END
$selfcheck$;

COMMIT;
