-- 自研引擎平台规则接入 Admin managed-config：
--   1) system_instructions / pref_word_count_tiers 进入运营台草稿→发布→回滚通路
--   2) pref_word_count_tiers 升级为可增删的 UI 驱动档位表
--   3) 放开 miniapp_user_settings.pref_word_count 的四值 CHECK

BEGIN;

-- ─── 1. 用户偏好：档位 id 改为自由文本（权威列表在 runtime_config）──────────
ALTER TABLE miniapp.miniapp_user_settings
  DROP CONSTRAINT IF EXISTS miniapp_user_settings_pref_word_count_check;

ALTER TABLE miniapp.miniapp_user_settings
  DROP CONSTRAINT IF EXISTS miniapp_user_settings_pref_word_count_check1;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint AS con
    JOIN pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'miniapp'
      AND rel.relname = 'miniapp_user_settings'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%pref_word_count%'
  LOOP
    EXECUTE format(
      'ALTER TABLE miniapp.miniapp_user_settings DROP CONSTRAINT IF EXISTS %I',
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE miniapp.miniapp_user_settings
  ADD CONSTRAINT miniapp_user_settings_pref_word_count_nonempty_check
  CHECK (char_length(trim(pref_word_count)) > 0);

COMMENT ON COLUMN miniapp.miniapp_user_settings.pref_word_count IS
  '回复长度档位 id，权威列表来自 miniapp.runtime_config.pref_word_count_tiers；非法或下线 id 由应用层回落到 default_tier_id。';

-- ─── 2. managed-config 白名单 ─────────────────────────────────────────────
ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers'
  ));

ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases
  ADD CONSTRAINT config_releases_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers'
  ));

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers'
  );
$$;

-- ─── 3. 校验：system_instructions（markdown text_value）+ 新档位表 ────────
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}}, {{INTERACTION_MODE}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'pref_word_count_tiers' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'pref_word_count_tiers must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_value -> 'tiers') = 0
       OR jsonb_typeof(p_value -> 'default_tier_id') IS DISTINCT FROM 'string'
       OR COALESCE(char_length(trim(p_value ->> 'default_tier_id')), 0) = 0 THEN
      RAISE EXCEPTION
        'pref_word_count_tiers must include nonempty tiers and default_tier_id'
        USING ERRCODE = '22023';
    END IF;

    v_columns := NULLIF(p_value #>> '{layout,columns}', '')::NUMERIC;
    IF v_columns IS NULL OR v_columns NOT IN (2, 3, 4) THEN
      RAISE EXCEPTION 'pref_word_count_tiers.layout.columns must be 2, 3 or 4'
        USING ERRCODE = '22023';
    END IF;

    v_ids := ARRAY[]::TEXT[];
    v_default := trim(p_value ->> 'default_tier_id');

    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_value -> 'tiers')
    LOOP
      IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
         OR COALESCE(char_length(trim(v_tier ->> 'id')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'ui_label')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'prompt_value')), 0) = 0
         OR jsonb_typeof(v_tier -> 'enabled') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(v_tier -> 'sort_order') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'pref_word_count_tiers contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF trim(v_tier ->> 'id') = ANY (v_ids) THEN
        RAISE EXCEPTION 'pref_word_count_tiers tier ids must be unique'
          USING ERRCODE = '22023';
      END IF;
      v_ids := array_append(v_ids, trim(v_tier ->> 'id'));

      IF trim(v_tier ->> 'id') = v_default AND (v_tier ->> 'enabled')::BOOLEAN IS TRUE THEN
        v_enabled_default := TRUE;
      END IF;
    END LOOP;

    IF NOT v_enabled_default THEN
      RAISE EXCEPTION 'pref_word_count_tiers.default_tier_id must match an enabled tier'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_character_free_chat_quota_limit' THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION
        'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
        USING ERRCODE = '22023';
    END IF;
    PERFORM p_text_value;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_fixed_billing(
    p_config_key,
    p_value,
    p_text_value
  );
  IF p_config_key = 'llm_pricing_config' THEN
    PERFORM admin.validate_fixed_llm_deduction_config(p_value);
  END IF;
END;
$$;

-- ─── 4. 升级已有 pref_word_count_tiers 到新 shape（保留旧 label 作 id）─────
UPDATE miniapp.runtime_config
SET
  value = jsonb_build_object(
    'tiers', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', trim(tier ->> 'label'),
          'ui_label', CASE trim(tier ->> 'label')
            WHEN '100-300' THEN '简短'
            WHEN '300-500' THEN '适中'
            WHEN '500-800' THEN '详细'
            WHEN '800+' THEN '长篇'
            ELSE trim(tier ->> 'label')
          END,
          'prompt_value', trim(tier ->> 'prompt_value'),
          'enabled', TRUE,
          'sort_order', (ordinality - 1)
        )
        ORDER BY ordinality
      )
      FROM jsonb_array_elements(value -> 'tiers') WITH ORDINALITY AS t(tier, ordinality)
      WHERE COALESCE(char_length(trim(tier ->> 'label')), 0) > 0
        AND COALESCE(char_length(trim(tier ->> 'prompt_value')), 0) > 0
    ), '[]'::JSONB),
    'default_tier_id', COALESCE(
      NULLIF(trim(value ->> 'default_value'), ''),
      '300-500'
    ),
    'layout', jsonb_build_object('columns', 4)
  ),
  description =
    '{{WORD_COUNT}} 档位表。id 写入用户 pref_word_count；ui_label 是 MiniApp 按钮文案；prompt_value 注入模板；layout.columns 控制按钮列数。',
  version = version + 1,
  updated_at = now()
WHERE key = 'pref_word_count_tiers'
  AND value ? 'default_value'
  AND NOT (value ? 'default_tier_id');

-- 若环境尚无新 shape（例如全新库只跑了 071 之后本迁移前被手工清过），兜底成完整默认表
INSERT INTO miniapp.runtime_config (
  key, value, description, version, updated_at, text_value
) VALUES (
  'pref_word_count_tiers',
  '{
    "tiers": [
      {"id":"100-300","ui_label":"简短","prompt_value":"100-300","enabled":true,"sort_order":0},
      {"id":"300-500","ui_label":"适中","prompt_value":"300-500","enabled":true,"sort_order":1},
      {"id":"500-800","ui_label":"详细","prompt_value":"500-800","enabled":true,"sort_order":2},
      {"id":"800+","ui_label":"长篇","prompt_value":"800以上","enabled":true,"sort_order":3}
    ],
    "default_tier_id": "300-500",
    "layout": {"columns": 4}
  }'::JSONB,
  '{{WORD_COUNT}} 档位表。id 写入用户 pref_word_count；ui_label 是 MiniApp 按钮文案；prompt_value 注入模板；layout.columns 控制按钮列数。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

UPDATE miniapp.runtime_config
SET
  description =
    '自研引擎平台规则模板（markdown）。含 {{WORD_COUNT}} / {{INTERACTION_MODE}} / {{USER_CUSTOM_INSTRUCTIONS}}；运营台以 text_value 发布新快照。'
WHERE key = 'system_instructions';

COMMENT ON FUNCTION admin.is_managed_config_key(TEXT) IS
  'Returns true when the config key is managed by the admin draft/publish pipeline.';

COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Validates managed runtime_config payloads before draft save / publish / rollback.';

COMMIT;
