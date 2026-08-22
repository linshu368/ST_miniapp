-- Add an operator-managed confirmation dialog shown before opening payment.

BEGIN;

INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at, text_value)
VALUES (
  'miniapp_payment_prompt_dialog_config',
  '{
    "enabled": true,
    "title": "支付前请先关闭 VPN",
    "description": "为避免支付页面无法打开、订单异常或到账延迟，请关闭 VPN 后再继续支付。",
    "confirm_text": "已关闭VPN，去截图保存二维码",
    "accent_color": "#f59e0b"
  }'::JSONB,
  '打开外部支付页前展示的 VPN 提醒弹窗，可配置启用状态、文案与统一强调色。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params'
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
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params'
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
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params'
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_payment_prompt_dialog_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'enabled') IS DISTINCT FROM 'boolean'
     OR COALESCE(char_length(trim(p_value ->> 'title')), 0) NOT BETWEEN 1 AND 40
     OR COALESCE(char_length(trim(p_value ->> 'description')), 0) NOT BETWEEN 1 AND 200
     OR COALESCE(char_length(trim(p_value ->> 'confirm_text')), 0) NOT BETWEEN 1 AND 30
     OR COALESCE(p_value ->> 'accent_color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NOT NULL
     AND to_regprocedure(
       'admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)'
     ) IS NULL THEN
    ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
      RENAME TO validate_managed_config_value_before_payment_prompt;
  END IF;
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
  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_payment_prompt_dialog_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_payment_prompt(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION admin.validate_payment_prompt_dialog_config(JSONB) IS
  'Validate the enabled state, copy and accent color for the pre-payment prompt dialog.';

COMMIT;

NOTIFY pgrst, 'reload schema';
