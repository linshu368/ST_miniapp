-- domain: admin
-- Restore the system_instructions text_value contract at the outermost managed-config validator.
--
-- Preconditions:
--   - 076_engine_admin_platform_instructions.sql established system_instructions as text_value.
--   - The current validator owner and delegation chain match the repository's latest wrappers.
--   - app_core.runtime_config still has a nonempty text_value and NULL value for this key.
--
-- Invariant:
--   system_instructions accepts only nonempty markdown in text_value, keeps value NULL, and retains
--   all three runtime placeholders. Other managed keys keep their existing validation branches.
--
-- Lock/capacity:
--   CREATE OR REPLACE FUNCTION takes routine metadata locks only. There is no table rewrite,
--   business-row scan, backfill, retry, or new runtime dependency.
--
-- Recovery:
--   A failed preflight/self-check rolls back the whole file. After commit, preserve all config data
--   and use a reviewed forward migration if another validator branch needs correction; do not
--   restore the known-broken behavior that rejects system_instructions text_value.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_owner name;
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_vip_strategy(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'system instructions validator preflight: expected validator chain is missing';
  END IF;

  SELECT r.rolname
    INTO STRICT v_owner
  FROM pg_proc AS p
  JOIN pg_roles AS r ON r.oid = p.proowner
  WHERE p.oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;

  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'system instructions validator preflight: unexpected owner %', v_owner;
  END IF;

  IF to_regclass('app_core.runtime_config') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM app_core.runtime_config
       WHERE key = 'system_instructions'
         AND value IS NULL
         AND text_value IS NOT NULL
         AND char_length(btrim(text_value)) > 0
     ) THEN
    RAISE EXCEPTION 'system instructions validator preflight: runtime baseline is missing or malformed';
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
BEGIN
  -- This text contract must terminate before later wrapper delegates. A historical wrapper drifted
  -- into the generic JSON-only guard and made the Admin's correct text_value payload unsavable.
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
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

  IF p_config_key LIKE 'image_advanced_%' THEN
    RAISE EXCEPTION 'advanced image configuration is no longer managed'
      USING ERRCODE = '22023';
  END IF;

  IF p_config_key IN (
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config',
    'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits',
    'media_feature_free_trial_limit'
  ) AND p_text_value IS NOT NULL THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;

  IF p_config_key IN ('vip_purchase_enabled', 'vip_reminders_enabled') THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION '% must be a JSON boolean', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'vip_plans_config' THEN
    PERFORM admin.validate_vip_plans_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'vip_text_discount_rate' THEN
    PERFORM admin.validate_vip_text_discount_rate(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'vip_checkin_bonus_config' THEN
    PERFORM admin.validate_vip_checkin_bonus_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'feature_free_trial_limits' THEN
    PERFORM admin.validate_feature_free_trial_limits(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'media_feature_free_trial_limit' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}') !~ '^[0-9]+$'
       OR (p_value #>> '{}')::integer NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'media_feature_free_trial_limit must be an integer between 1 and 100'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'image_description_system_prompt' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_description_system_prompt must store text in text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'image_description_system_prompt text_value must be nonempty'
        USING ERRCODE = '22023';
    END IF;
    IF char_length(p_text_value) > 12000 THEN
      RAISE EXCEPTION 'image_description_system_prompt is too long' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'llm_provider_routing_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'llm_provider_routing_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    IF to_regprocedure('admin.validate_llm_provider_routing_config(jsonb)') IS NULL THEN
      RAISE EXCEPTION 'llm_provider_routing_config validator missing' USING ERRCODE = '55000';
    END IF;
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_vip_strategy(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$fn$;

REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $selfcheck$
DECLARE
  v_rejected boolean;
BEGIN
  PERFORM admin.validate_managed_config_value(
    'system_instructions',
    NULL,
    '{{WORD_COUNT}} {{INTERACTION_MODE}} {{USER_CUSTOM_INSTRUCTIONS}}'
  );

  v_rejected := false;
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'system_instructions',
      '"wrong-column"'::jsonb,
      '{{WORD_COUNT}} {{INTERACTION_MODE}} {{USER_CUSTOM_INSTRUCTIONS}}'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := position('value must be null' IN SQLERRM) > 0;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'self-check failed: system_instructions accepted JSONB value';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, '   ');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := position('nonempty markdown string' IN SQLERRM) > 0;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'self-check failed: system_instructions accepted empty text_value';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'system_instructions',
      NULL,
      '{{WORD_COUNT}} {{INTERACTION_MODE}}'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := position('must contain' IN SQLERRM) > 0;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'self-check failed: system_instructions accepted missing placeholders';
  END IF;

  -- One existing branch proves that restoring the text contract did not bypass current wrappers.
  PERFORM admin.validate_managed_config_value('vip_purchase_enabled', 'false'::jsonb, NULL);
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
