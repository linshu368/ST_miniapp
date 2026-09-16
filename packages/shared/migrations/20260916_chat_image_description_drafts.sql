-- 20260916: 图片描述调用前审计与 draft attempt 状态。
-- domain: experience + app_core + admin
-- 前置：20260914_chat_message_images.sql 已执行。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.chat_message_images
  ADD COLUMN IF NOT EXISTS description_user_prompt TEXT;

ALTER TABLE experience.chat_message_images
  ALTER COLUMN prompt_cn DROP NOT NULL,
  ALTER COLUMN prompt_source DROP NOT NULL;

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_status_check;
ALTER TABLE experience.chat_message_images
  ADD CONSTRAINT chat_message_images_status_check CHECK (status IN (
    'draft_describing', 'draft_ready', 'draft_failed',
    'pending', 'leased', 'generating', 'storing', 'ready', 'failed', 'failed_unknown'
  ));

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_prompt_state_check;
ALTER TABLE experience.chat_message_images
  ADD CONSTRAINT chat_message_images_prompt_state_check CHECK (
    (status = 'draft_describing' AND description_user_prompt IS NOT NULL)
    OR (status = 'draft_failed' AND description_user_prompt IS NOT NULL)
    OR (status = 'draft_ready'
        AND description_user_prompt IS NOT NULL
        AND prompt_cn IS NOT NULL
        AND prompt_source = 'generated')
    OR (status IN ('pending', 'leased', 'generating', 'storing', 'ready', 'failed', 'failed_unknown')
        AND prompt_cn IS NOT NULL
        AND prompt_source IS NOT NULL)
  );

COMMENT ON COLUMN experience.chat_message_images.description_user_prompt IS
  '图片描述模型调用前保存的完整 user prompt；含角色与对话敏感正文，仅 backend service role 可读。';

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at, text_value)
VALUES (
  'image_text_model_config',
  '{"url":"","api_key":"","model":""}'::JSONB,
  '图片描述与翻译使用的 OpenAI-compatible 文本模型配置；空字段时回退当前 DeepSeek 参数。由 Admin 环境权限保护并供 backend 消费。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- image_text_model_config 不写入真实密钥，空配置时 backend 默认使用当前 DeepSeek 配置。
-- 运维按单行 JSON 原子配置：{"url":"https://...","api_key":"...","model":"..."}。
-- 用户明确要求从 Admin 的 test/production 草稿发布链路管理；API key 只在密码框录入，UI 预览脱敏。

CREATE OR REPLACE FUNCTION admin.validate_image_text_model_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_url TEXT;
  v_api_key TEXT;
  v_model TEXT;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR NOT (p_value ?& ARRAY['url', 'api_key', 'model'])
     OR (p_value - ARRAY['url', 'api_key', 'model']) <> '{}'::jsonb
     OR jsonb_typeof(p_value -> 'url') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_value -> 'api_key') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_value -> 'model') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'image_text_model_config must contain only string url/api_key/model fields'
      USING ERRCODE = '22023';
  END IF;

  v_url := trim(p_value ->> 'url');
  v_api_key := trim(p_value ->> 'api_key');
  v_model := trim(p_value ->> 'model');
  IF char_length(v_url) > 2048 OR char_length(v_api_key) > 4096 OR char_length(v_model) > 256 THEN
    RAISE EXCEPTION 'image_text_model_config field is too long' USING ERRCODE = '22023';
  END IF;
  IF v_url = '' AND v_api_key = '' AND v_model = '' THEN
    RETURN;
  END IF;
  IF v_url = '' OR v_api_key = '' OR v_model = '' OR v_url !~ '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'image_text_model_config must be an all-empty fallback tuple or complete HTTPS tuple'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

-- 目标库可能保留已下线 key 的历史 draft/release（例如旧 voice billing 草稿）。
-- 不能用仓库当前白名单整段覆盖 CHECK，否则 ADD CONSTRAINT 会被这些历史行阻断。
-- 这里读取目标库当前约束表达式，只做单调扩展，既不放宽其他新 key，也不改写历史数据。
DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
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
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = %L)',
      v_table,
      v_constraint_name,
      v_existing_expression,
      'image_text_model_config'
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits', 'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit', 'miniapp_payment_plans',
    'miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config', 'llm_model_catalog', 'llm_pricing_config',
    'system_fallback_character_id', 'system_instructions', 'pref_word_count_tiers',
    'lobby_ranking_params', 'lobby_pinned_characters', 'miniapp_invite_reward_rules',
    'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_default_art_style', 'image_width', 'image_height', 'image_max_prompt_chars',
    'image_max_output_bytes', 'image_prompt_policy', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint',
    'image_text_model_config'
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'image_text_model_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_text_model_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_text_model_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_reward_rules must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_center_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_center_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a JSON boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key IN (
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_default_art_style', 'image_width', 'image_height', 'image_max_prompt_chars',
    'image_max_output_bytes', 'image_prompt_policy', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint'
  ) THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key, p_value, p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_image_text_model_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'experience'
      AND table_name = 'chat_message_images'
      AND column_name = 'description_user_prompt'
  ) THEN
    RAISE EXCEPTION 'self-check failed: description_user_prompt missing';
  END IF;
  IF NOT admin.is_managed_config_key('image_text_model_config') THEN
    RAISE EXCEPTION 'self-check failed: image_text_model_config is not admin managed';
  END IF;
  PERFORM admin.validate_managed_config_value(
    'image_text_model_config',
    '{"url":"","api_key":"","model":""}'::jsonb,
    NULL
  );
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';