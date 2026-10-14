-- domain: app_core (+ admin managed-key surface)
-- 图片广场：标签展示/分享打标总开关；works.snapshot.prompt_zh 由脚本写入，无结构列变更。
--
-- 回滚：
--   1) UPDATE app_core.runtime_config SET value='true'::jsonb WHERE key='image_plaza_tags_feature_enabled';
--      或 DELETE 该 key 后由应用缺省视为开；
--   2) 可选：批量 jsonb - 'prompt_zh' 清理译文（不阻塞功能回滚）；
--   3) Admin managed-key 名单回退需 forward-fix，勿改写本文件历史。

ALTER FUNCTION admin.is_managed_config_key(TEXT) RENAME TO is_managed_config_key_before_image_plaza_tags_feature;
CREATE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT p_config_key = 'image_plaza_tags_feature_enabled'
    OR admin.is_managed_config_key_before_image_plaza_tags_feature(p_config_key)
$$;

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_image_plaza_tags_feature;
CREATE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT, p_value JSONB, p_text_value TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_config_key = 'image_plaza_tags_feature_enabled' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'image_plaza_tags_feature_enabled must be boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_image_plaza_tags_feature(
    p_config_key, p_value, p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.is_managed_config_key_before_image_plaza_tags_feature(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_image_plaza_tags_feature(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $widen_managed_config_checks$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
  v_was_validated BOOLEAN;
  v_keys CONSTANT TEXT[] := ARRAY['image_plaza_tags_feature_enabled'];
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::REGCLASS,
    'admin.config_releases'::REGCLASS
  ] LOOP
    v_constraint_name := CASE v_table
      WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;

    SELECT pg_get_expr(c.conbin, c.conrelid), c.convalidated
      INTO v_existing_expression, v_was_validated
    FROM pg_constraint AS c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    IF v_existing_expression IS NULL THEN
      RAISE EXCEPTION 'missing expected constraint %.%', v_table, v_constraint_name;
    END IF;
    IF v_keys <@ regexp_split_to_array(v_existing_expression, '[^a-z0-9_]+') THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = ANY (%L::text[]))%s',
      v_table,
      v_constraint_name,
      v_existing_expression,
      v_keys::TEXT,
      CASE WHEN v_was_validated THEN '' ELSE ' NOT VALID' END
    );
  END LOOP;
END
$widen_managed_config_checks$;

DO $check_managed_config_checks$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_definition TEXT;
  v_key TEXT;
  v_keys CONSTANT TEXT[] := ARRAY['image_plaza_tags_feature_enabled'];
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::REGCLASS,
    'admin.config_releases'::REGCLASS
  ] LOOP
    v_constraint_name := CASE v_table
      WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_constraintdef(c.oid)
      INTO v_definition
    FROM pg_constraint AS c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    FOREACH v_key IN ARRAY v_keys LOOP
      IF v_definition IS NULL OR position(v_key IN v_definition) = 0 THEN
        RAISE EXCEPTION 'self-check failed: %.% missing key %',
          v_table, v_constraint_name, v_key;
      END IF;
    END LOOP;
  END LOOP;
END
$check_managed_config_checks$;

INSERT INTO app_core.runtime_config(key, value, description)
VALUES (
  'image_plaza_tags_feature_enabled',
  'true'::JSONB,
  '图片广场标签筛选展示与分享自动打标总开关；false 时隐藏业务标签且分享不调用打标模型'
)
ON CONFLICT (key) DO NOTHING;

COMMENT ON COLUMN experience.image_plaza_works.snapshot IS
  '作品生成快照：prompt 为出图/同款英文原文；可选 prompt_zh 供详情展示与列表搜索';
