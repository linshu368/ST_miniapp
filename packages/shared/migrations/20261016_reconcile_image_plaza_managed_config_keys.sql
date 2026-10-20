-- domain: admin
-- 恢复被平台规则槽位迁移覆盖的图片广场白名单；不改业务行、正式配置或 validator。
-- 前置：20261012_image_plaza_v2.sql。保留目标库后续迁移增加的 key 和 CHECK。
-- TEST 经 Database Migration workflow 单文件 apply 后验收保存/发布/历史恢复；
-- Production 必须独立确认。一次性迁移，禁止 force_rerun。
-- 锁：两张运营表 ACCESS EXCLUSIVE，已验证 CHECK 重建可能扫描历史行；低峰执行。
-- 失败整体回滚；成功后保留兼容 key，使用新 forward-fix，勿删历史或恢复旧窄名单。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_image_plaza_model_catalog(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_image_plaza_share_tip(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_image_plaza_tags(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'image plaza key recovery: prerequisite functions missing';
  END IF;
  IF to_regprocedure('admin.is_managed_config_key_before_image_plaza_recovery(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'image plaza key recovery: already applied or unexpected predecessor';
  END IF;
  -- 保留既有执行身份，不把未知 SECURITY DEFINER/可变函数包成 IMMUTABLE。
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'admin.is_managed_config_key(text)'::regprocedure
      AND p.prorettype = 'boolean'::regtype AND NOT p.proretset
      AND NOT p.prosecdef AND p.provolatile = 'i' AND p.proparallel = 's'
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'image plaza key recovery: unexpected managed-key function shape/owner';
  END IF;
END
$preflight$;

LOCK TABLE admin.config_drafts, admin.config_releases IN ACCESS EXCLUSIVE MODE;

-- 改名保留旧函数 OID/owner/ACL。旧 CHECK 可能继续绑定旧 OID，因此仍需显式补齐 CHECK。
ALTER FUNCTION admin.is_managed_config_key(TEXT)
  RENAME TO is_managed_config_key_before_image_plaza_recovery;

CREATE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT p_config_key IN (
    'image_plaza_enabled', 'image_plaza_model_catalog',
    'image_plaza_share_tip', 'image_plaza_tags'
  ) OR admin.is_managed_config_key_before_image_plaza_recovery(p_config_key)
$$;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $widen_checks$
DECLARE
  v_table REGCLASS;
  v_name TEXT;
  v_expression TEXT;
  v_validated BOOLEAN;
  v_key TEXT;
  v_allowed BOOLEAN;
  v_keys CONSTANT TEXT[] := ARRAY[
    'image_plaza_enabled', 'image_plaza_model_catalog',
    'image_plaza_share_tip', 'image_plaza_tags'
  ];
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
      RAISE EXCEPTION 'image plaza key recovery: missing constraint %.%', v_table, v_name;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
      v_table, v_name, v_expression,
      CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
    );

    SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_expression
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c'
      AND c.convalidated = v_validated;
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'image plaza key recovery: constraint validation state changed';
    END IF;
    -- 对真实 CHECK 表达式做行为验证，不仅检查字符串出现；不读写业务行。
    FOREACH v_key IN ARRAY v_keys LOOP
      EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
        INTO v_allowed USING v_key;
      IF v_allowed IS DISTINCT FROM true
         OR admin.is_managed_config_key(v_key) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'image plaza key recovery: key % rejected by %', v_key, v_table;
      END IF;
    END LOOP;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING '__unknown_config_key__';
    IF v_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'image plaza key recovery: unknown key not rejected by %', v_table;
    END IF;
  END LOOP;
END
$widen_checks$;

DO $validator_selfcheck$
DECLARE
  v_key TEXT;
  v_value JSONB;
  v_rejected BOOLEAN;
BEGIN
  IF admin.is_managed_config_key('__unknown_config_key__') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'image plaza key recovery: unknown key accepted by whitelist';
  END IF;
  -- 新包装不能把专用后处理/退场配置或未知 key 纳入通用管理入口。
  FOREACH v_key IN ARRAY ARRAY[
    'system_instructions', 'llm_model_catalog', 'choice_rules', 'status_rules',
    'memory_rules', 'image_plaza_tags_feature_enabled',
    'miniapp_text_postprocess_config', 'interaction_mode_blocks', '__unknown_config_key__'
  ] LOOP
    IF admin.is_managed_config_key(v_key) IS DISTINCT FROM
       admin.is_managed_config_key_before_image_plaza_recovery(v_key) THEN
      RAISE EXCEPTION 'image plaza key recovery: unrelated key behavior changed: %', v_key;
    END IF;
  END LOOP;

  FOR v_key, v_value IN
    SELECT key, value FROM jsonb_each($json${
      "image_plaza_enabled": true,
      "image_plaza_model_catalog": {
        "default_model_id": "recovery-check",
        "models": [{
          "id": "recovery-check", "provider_model_id": "recovery-check",
          "name": "Recovery check", "description": "Validation only; never persisted",
          "enabled": true, "supports_i2i": false, "supports_edit": false,
          "sort_order": 0, "sizing_mode": "aspect_ratio", "aspect_ratios": ["1:1"],
          "resolutions": [{"id": "fixed", "label": "Fixed", "credits": 10}],
          "internal_tags": []
        }]
      },
      "image_plaza_share_tip": {
        "enabled": true, "title": "Share {model}", "description": "Return {rate}",
        "reference_note": "", "button_label": "Share"
      },
      "image_plaza_tags": [{"id": "portrait", "label": "Portrait", "enabled": true, "sort_order": 0}]
    }$json$::jsonb)
  LOOP
    PERFORM admin.validate_managed_config_value(v_key, v_value, NULL);
    v_rejected := false;
    BEGIN
      PERFORM admin.validate_managed_config_value(v_key, '"invalid"'::jsonb, NULL);
    EXCEPTION WHEN SQLSTATE '22023' THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'image plaza key recovery: invalid value accepted for %', v_key;
    END IF;
  END LOOP;
END
$validator_selfcheck$;

NOTIFY pgrst, 'reload schema';
COMMIT;