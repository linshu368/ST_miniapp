-- Make the pre-payment dialog footer note operator-managed.

BEGIN;

UPDATE miniapp.runtime_config
SET
  value = COALESCE(value, '{}'::JSONB) || jsonb_build_object(
    'footer_note',
    COALESCE(
      NULLIF(trim(value ->> 'footer_note'), ''),
      '点击确认后，将继续跳转到外部浏览器完成微信支付。'
    )
  ),
  description = '打开外部支付页前展示的 VPN 提醒弹窗，可配置启用状态、文案、底部提示与统一强调色。',
  version = version + 1,
  updated_at = now(),
  text_value = NULL
WHERE key = 'miniapp_payment_prompt_dialog_config';

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
     OR COALESCE(char_length(trim(p_value ->> 'footer_note')), 0) NOT BETWEEN 1 AND 100
     OR COALESCE(p_value ->> 'accent_color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_payment_prompt_dialog_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION admin.validate_payment_prompt_dialog_config(JSONB) IS
  'Validate the enabled state, copy, footer note and accent color for the pre-payment prompt dialog.';

COMMIT;

NOTIFY pgrst, 'reload schema';
