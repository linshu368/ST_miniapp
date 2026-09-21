-- 20260916: 修复目标库后续 managed-config 迁移覆盖图片配置 CHECK 的问题。
-- domain: admin
--
-- 前置：
--   1. 20260914_chat_message_images.sql
--   2. 20260916_chat_image_description_drafts.sql
--
-- 目标库当前 CHECK 保留了上游新增的 llm_provider_routing_config，却只包含
-- image_text_model_config，其他图片 key 被后执行的并行迁移覆盖。这里基于目标库
-- 当前约束做单调扩展，不重写上游白名单、不删除历史草稿或发布记录。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
  v_image_keys CONSTANT TEXT[] := ARRAY[
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_text_model_config',
    'image_prompt_policy',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ];
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::REGCLASS,
    'admin.config_releases'::REGCLASS
  ] LOOP
    v_constraint_name := CASE v_table
      WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;

    SELECT pg_get_expr(c.conbin, c.conrelid)
      INTO v_existing_expression
    FROM pg_constraint c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    IF v_existing_expression IS NULL THEN
      RAISE EXCEPTION 'missing expected constraint %.%', v_table, v_constraint_name;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = ANY (%L::text[]))',
      v_table,
      v_constraint_name,
      v_existing_expression,
      v_image_keys::TEXT
    );
  END LOOP;
END;
$$;

-- 两张表的 CHECK 必须包含 Admin 图片配置页可能保存/发布的每一个 key。
DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_definition TEXT;
  v_key TEXT;
  v_image_keys CONSTANT TEXT[] := ARRAY[
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_text_model_config',
    'image_prompt_policy',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ];
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
    FROM pg_constraint c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    FOREACH v_key IN ARRAY v_image_keys LOOP
      IF v_definition IS NULL OR position(v_key IN v_definition) = 0 THEN
        RAISE EXCEPTION 'self-check failed: %.% missing key %',
          v_table, v_constraint_name, v_key;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：无破坏性紧急回滚。保留新增 key 的 CHECK 兼容性；若必须移除，应先确认两张表
-- 没有对应 key 的历史行，再基于当时目标库约束创建独立 forward-fix，禁止恢复旧静态名单。