-- 20260917: 运营可管理的「模型 × 供应商」OpenRouter 路由配置。
-- domain: admin + app_core
--
-- 前置：
--   1. 20260916_chat_image_description_drafts.sql
--   2. 20260916_reconcile_chat_image_managed_config_keys.sql
--
-- 本文件取代 PR #316 原先的 110_llm_provider_routing_config.sql。
-- 110 是三位编号，且会整表重写 CHECK；test 上已因此覆盖过图片 key
--（见 20260916_reconcile）。这里只做单调扩展：不收缩白名单、不删历史草稿。
--
-- 行为：
--   rules[].blocked_providers   -> provider.ignore
--   rules[].preferred_providers -> provider.order + allow_fallbacks: true
-- seed 为空 rules，不改变默认路由。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regprocedure('admin.validate_image_text_model_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_image_text_model_config，请先执行 20260916_chat_image_description_drafts.sql';
  END IF;
  IF to_regprocedure('admin.validate_image_generation_config_value(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_image_generation_config_value，请先执行 20260914_chat_message_images.sql';
  END IF;
  IF to_regprocedure('admin.validate_invite_reward_rules(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_invite_center_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 invite 校验函数，请先执行 105_invite_program.sql';
  END IF;
END;
$$;

-- ─── 1. seed（空规则）──────────────────────────────────────────────────────
DO $$
DECLARE
  runtime_tbl regclass;
BEGIN
  runtime_tbl := COALESCE(
    to_regclass('app_core.runtime_config'),
    to_regclass('miniapp.runtime_config')
  );
  IF runtime_tbl IS NULL THEN
    RAISE EXCEPTION 'runtime_config not found in app_core or miniapp';
  END IF;
  EXECUTE format(
    $sql$
      INSERT INTO %s (key, value, description, version, updated_at)
      VALUES (
        'llm_provider_routing_config',
        '{"rules": []}'::jsonb,
        '「模型 × 供应商」OpenRouter 路由规则：blocked_providers 写入 provider.ignore（屏蔽），'
        'preferred_providers 写入 provider.order 并允许兜底回落。规则按 openrouter_model_id 生效，'
        '空 rules 表示不干预任何模型的默认路由。',
        1,
        now()
      )
      ON CONFLICT (key) DO NOTHING
    $sql$,
    runtime_tbl
  );
END;
$$;

-- ─── 2. CHECK 单调追加，不重写上游白名单 ──────────────────────────────────
DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
  v_key CONSTANT TEXT := 'llm_provider_routing_config';
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
    IF position(v_key IN v_existing_expression) > 0 THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = %L)',
      v_table,
      v_constraint_name,
      v_existing_expression,
      v_key
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
    'llm_provider_routing_config',
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

-- ─── 3. 库侧校验（与 shared LlmProviderRoutingConfigSchema 同口径）──────────
CREATE OR REPLACE FUNCTION admin.validate_provider_slug_list(p_list JSONB, p_field TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_item JSONB;
  v_slug TEXT;
  v_slugs TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_list IS NULL OR jsonb_typeof(p_list) = 'null' THEN
    RETURN v_slugs;
  END IF;
  IF jsonb_typeof(p_list) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'llm_provider_routing_config: % must be an array', p_field
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_list) > 20 THEN
    RAISE EXCEPTION 'llm_provider_routing_config: % must not exceed 20 entries', p_field
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_list)
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'llm_provider_routing_config: % must contain only strings', p_field
        USING ERRCODE = '22023';
    END IF;
    v_slug := trim(v_item #>> '{}');
    IF v_slug = ''
       OR char_length(v_slug) > 64
       OR v_slug !~ '^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$' THEN
      RAISE EXCEPTION 'llm_provider_routing_config: % contains an invalid provider slug: %', p_field, v_slug
        USING ERRCODE = '22023';
    END IF;
    IF lower(v_slug) = ANY (v_slugs) THEN
      RAISE EXCEPTION 'llm_provider_routing_config: % must not repeat provider %', p_field, v_slug
        USING ERRCODE = '22023';
    END IF;
    v_slugs := array_append(v_slugs, lower(v_slug));
  END LOOP;
  RETURN v_slugs;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_llm_provider_routing_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_rule JSONB;
  v_model TEXT;
  v_models TEXT[] := ARRAY[]::TEXT[];
  v_blocked TEXT[];
  v_preferred TEXT[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'llm_provider_routing_config must be a JSON object'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'llm_provider_routing_config.rules must be an array'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_value -> 'rules') > 100 THEN
    RAISE EXCEPTION 'llm_provider_routing_config.rules must not exceed 100 entries'
      USING ERRCODE = '22023';
  END IF;

  FOR v_rule IN SELECT value FROM jsonb_array_elements(p_value -> 'rules')
  LOOP
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'llm_provider_routing_config.rules must contain only objects'
        USING ERRCODE = '22023';
    END IF;

    v_model := trim(v_rule ->> 'openrouter_model_id');
    IF v_model IS NULL
       OR char_length(v_model) < 3
       OR char_length(v_model) > 200
       OR v_model !~ '^[^[:space:]/]+/[^[:space:]/]+$' THEN
      RAISE EXCEPTION
        'llm_provider_routing_config: openrouter_model_id must look like vendor/model, got %',
        COALESCE(v_model, '<null>')
        USING ERRCODE = '22023';
    END IF;
    IF lower(v_model) = ANY (v_models) THEN
      RAISE EXCEPTION 'llm_provider_routing_config: duplicate rule for model %', v_model
        USING ERRCODE = '22023';
    END IF;
    v_models := array_append(v_models, lower(v_model));

    v_blocked := admin.validate_provider_slug_list(v_rule -> 'blocked_providers', 'blocked_providers');
    v_preferred := admin.validate_provider_slug_list(v_rule -> 'preferred_providers', 'preferred_providers');

    IF COALESCE(array_length(v_blocked, 1), 0) = 0
       AND COALESCE(array_length(v_preferred, 1), 0) = 0 THEN
      RAISE EXCEPTION
        'llm_provider_routing_config: rule for % must list at least one blocked or preferred provider',
        v_model
        USING ERRCODE = '22023';
    END IF;
    IF v_blocked && v_preferred THEN
      RAISE EXCEPTION
        'llm_provider_routing_config: rule for % lists a provider as both blocked and preferred',
        v_model
        USING ERRCODE = '22023';
    END IF;

    IF v_rule ? 'note' AND jsonb_typeof(v_rule -> 'note') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'llm_provider_routing_config: note must be a string'
        USING ERRCODE = '22023';
    END IF;
    IF char_length(COALESCE(v_rule ->> 'note', '')) > 200 THEN
      RAISE EXCEPTION 'llm_provider_routing_config: note must not exceed 200 characters'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

-- 快照 20260916_chat_image_description_drafts 的入口：新 key 只走外层，其余委托这里。
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value_before_provider_routing(
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
  IF p_config_key = 'llm_provider_routing_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'llm_provider_routing_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_provider_routing(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_provider_slug_list(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_llm_provider_routing_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_provider_routing(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. 自检 ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def TEXT;
  v_raised BOOLEAN;
  runtime_tbl regclass;
  v_seeded INT;
  v_key TEXT;
  v_keep_keys CONSTANT TEXT[] := ARRAY[
    'llm_provider_routing_config',
    'lobby_pinned_characters',
    'miniapp_payment_prompt_dialog_config',
    'llm_model_catalog',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled',
    'image_generation_enabled',
    'image_text_model_config',
    'image_prompt_policy'
  ];
BEGIN
  FOREACH v_key IN ARRAY v_keep_keys LOOP
    IF NOT admin.is_managed_config_key(v_key) THEN
      RAISE EXCEPTION '自检失败：is_managed_config_key(%) 返回 false', v_key;
    END IF;
  END LOOP;

  FOR v_def IN
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
      AND conname LIKE '%config_key_check'
  LOOP
    FOREACH v_key IN ARRAY v_keep_keys LOOP
      IF position(v_key IN v_def) = 0 THEN
        RAISE EXCEPTION '自检失败：CHECK 约束缺少 key % -> %', v_key, v_def;
      END IF;
    END LOOP;
  END LOOP;

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('llm_provider_routing_config', '{"rules": []}'::jsonb, 'probe');
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
    IF position('must not use text_value' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION '自检失败：llm_provider_routing_config 没走到自己的分支，实际报错为 %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：llm_provider_routing_config 的 text_value 守卫失效';
  END IF;

  PERFORM admin.validate_managed_config_value('llm_provider_routing_config', '{"rules": []}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value(
    'llm_provider_routing_config',
    '{"rules": [{"openrouter_model_id": "deepseek/deepseek-chat-v3.2", "blocked_providers": ["alibaba"], "preferred_providers": [], "note": "probe"}]}'::jsonb,
    NULL
  );

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'llm_provider_routing_config',
      '{"rules": [{"openrouter_model_id": "a/b", "blocked_providers": [], "preferred_providers": []}]}'::jsonb,
      NULL
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：空规则被静默放过';
  END IF;

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：校验链下沉断了，system_instructions 放过了空值';
  END IF;

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('miniapp_invite_center_config', '{}'::jsonb, 'probe');
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
    IF position('must not use text_value' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION '自检失败：invite 分支没接到，实际报错为 %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：miniapp_invite_center_config 的校验分支静默放过了非法输入';
  END IF;

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('image_text_model_config', '{}'::jsonb, 'probe');
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
    IF position('must not use text_value' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION '自检失败：图片配置分支没接到，实际报错为 %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：image_text_model_config 的校验分支静默放过了非法输入';
  END IF;

  runtime_tbl := COALESCE(
    to_regclass('app_core.runtime_config'),
    to_regclass('miniapp.runtime_config')
  );
  EXECUTE format(
    'SELECT count(*) FROM %s WHERE key = ''llm_provider_routing_config''',
    runtime_tbl
  ) INTO v_seeded;
  IF v_seeded <> 1 THEN
    RAISE EXCEPTION '自检失败：runtime_config 缺少 llm_provider_routing_config 的 seed 行';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.validate_llm_provider_routing_config(JSONB) IS
  '校验「模型 × 供应商」路由配置：rules 数组按 openrouter_model_id 去重，每条至少一个'
  '屏蔽或优先供应商，供应商 slug 列表内去重且黑白名单不得交叉。';
COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Managed config validation entry point. Handles llm_provider_routing_config, then defers to the 20260916 image/invite snapshot.';

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：无破坏性紧急回滚。保留 seed 与 CHECK 兼容性。若必须移除，应先确认两张表
-- 没有 llm_provider_routing_config 历史行，再写独立 forward-fix，禁止恢复旧静态名单。
