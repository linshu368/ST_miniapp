-- domain: app_core / admin
-- Extend the published recharge-plan configuration with customer-facing payment-channel entry
-- visibility. The gateway and billing order contract intentionally remain unchanged.
--
-- Invariants:
-- - Legacy plan arrays remain valid for staged application rollout.
-- - New objects contain plans plus exactly two channel flags and an enabled default channel.
-- - Admin drafts, releases, and published runtime config share the same validator.
--
-- Lock/capacity: CREATE OR REPLACE FUNCTION only; no table rewrite or business-row scan.
-- Recovery: a preflight/self-check failure rolls back. After applying, use a forward migration to
-- adjust validation; do not delete existing drafts/releases or mutate historical orders.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_vip_strategy(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'payment channels config preflight: managed-config validator chain is missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_default TEXT;
  v_alipay_enabled BOOLEAN;
  v_wxpay_enabled BOOLEAN;
BEGIN
  IF p_config_key = 'miniapp_payment_plans' AND jsonb_typeof(p_value) = 'object' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_plans must not use text_value' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_value) AS key
      WHERE key NOT IN ('plans', 'payment_channels')
    ) OR (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 2 THEN
      RAISE EXCEPTION 'miniapp_payment_plans only accepts plans and payment_channels'
        USING ERRCODE = '22023';
    END IF;

    -- Keep the established DB validator as the source of truth for every plan field.
    PERFORM admin.validate_managed_config_value_before_vip_strategy(
      'miniapp_payment_plans',
      p_value -> 'plans',
      NULL
    );

    IF jsonb_typeof(p_value -> 'payment_channels') IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_value -> 'payment_channels')) <> 3
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_value -> 'payment_channels') AS key
         WHERE key NOT IN ('alipay_enabled', 'wxpay_enabled', 'default_payment_type')
       ) THEN
      RAISE EXCEPTION 'payment_channels must contain exactly alipay_enabled, wxpay_enabled and default_payment_type'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_value -> 'payment_channels' -> 'alipay_enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(p_value -> 'payment_channels' -> 'wxpay_enabled') IS DISTINCT FROM 'boolean'
       OR (p_value -> 'payment_channels' ->> 'default_payment_type') NOT IN ('alipay', 'wxpay') THEN
      RAISE EXCEPTION 'payment_channels has invalid field types' USING ERRCODE = '22023';
    END IF;
    v_alipay_enabled := (p_value -> 'payment_channels' ->> 'alipay_enabled')::boolean;
    v_wxpay_enabled := (p_value -> 'payment_channels' ->> 'wxpay_enabled')::boolean;
    v_default := p_value -> 'payment_channels' ->> 'default_payment_type';
    IF NOT v_alipay_enabled AND NOT v_wxpay_enabled THEN
      RAISE EXCEPTION 'at least one payment channel must be enabled' USING ERRCODE = '22023';
    END IF;
    IF (v_default = 'alipay' AND NOT v_alipay_enabled)
       OR (v_default = 'wxpay' AND NOT v_wxpay_enabled) THEN
      RAISE EXCEPTION 'default payment channel must be enabled' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)' USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string' USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION 'system_instructions must contain required placeholders' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key LIKE 'image_advanced_%' THEN
    RAISE EXCEPTION 'advanced image configuration is no longer managed' USING ERRCODE = '22023';
  END IF;
  IF p_config_key IN ('vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config', 'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits', 'media_feature_free_trial_limit')
     AND p_text_value IS NOT NULL THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;
  IF p_config_key IN ('vip_purchase_enabled', 'vip_reminders_enabled') THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION '% must be a JSON boolean', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'vip_plans_config' THEN PERFORM admin.validate_vip_plans_config(p_value); RETURN; END IF;
  IF p_config_key = 'vip_text_discount_rate' THEN PERFORM admin.validate_vip_text_discount_rate(p_value); RETURN; END IF;
  IF p_config_key = 'vip_checkin_bonus_config' THEN PERFORM admin.validate_vip_checkin_bonus_config(p_value); RETURN; END IF;
  IF p_config_key = 'feature_free_trial_limits' THEN PERFORM admin.validate_feature_free_trial_limits(p_value); RETURN; END IF;
  IF p_config_key = 'media_feature_free_trial_limit' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR (p_value #>> '{}') !~ '^[0-9]+$' OR (p_value #>> '{}')::integer NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'media_feature_free_trial_limit must be an integer between 1 and 100' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'image_description_system_prompt' THEN
    IF p_value IS NOT NULL OR p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 OR char_length(p_text_value) > 12000 THEN
      RAISE EXCEPTION 'image_description_system_prompt must use a nonempty text_value up to 12000 chars' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'llm_provider_routing_config' THEN
    IF p_text_value IS NOT NULL THEN RAISE EXCEPTION 'llm_provider_routing_config must not use text_value' USING ERRCODE = '22023'; END IF;
    IF to_regprocedure('admin.validate_llm_provider_routing_config(jsonb)') IS NULL THEN RAISE EXCEPTION 'llm_provider_routing_config validator missing' USING ERRCODE = '55000'; END IF;
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_vip_strategy(p_config_key, p_value, p_text_value);
END;
$fn$;

REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $selfcheck$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  -- A legacy array remains deployable while old app processes are being replaced.
  PERFORM admin.validate_managed_config_value(
    'miniapp_payment_plans',
    '[{"id":"legacy","price_cents":100,"original_price_cents":null,"credits_amount":100,"bonus_credits":0,"variant":"entry","badge_text":null,"sub_copy":null,"highlight_text":null}]'::jsonb,
    NULL
  );
  PERFORM admin.validate_managed_config_value(
    'miniapp_payment_plans',
    '{"plans":[{"id":"alipay-only","price_cents":100,"original_price_cents":null,"credits_amount":100,"bonus_credits":0,"variant":"entry","badge_text":null,"sub_copy":null,"highlight_text":null}],"payment_channels":{"alipay_enabled":true,"wxpay_enabled":false,"default_payment_type":"alipay"}}'::jsonb,
    NULL
  );
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'miniapp_payment_plans',
      '{"plans":[{"id":"invalid-default","price_cents":100,"original_price_cents":null,"credits_amount":100,"bonus_credits":0,"variant":"entry","badge_text":null,"sub_copy":null,"highlight_text":null}],"payment_channels":{"alipay_enabled":true,"wxpay_enabled":false,"default_payment_type":"wxpay"}}'::jsonb,
      NULL
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'self-check failed: disabled default channel was accepted'; END IF;
END
$selfcheck$;

COMMIT;
NOTIFY pgrst, 'reload schema';
