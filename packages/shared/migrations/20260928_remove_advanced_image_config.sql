-- 20260928: remove advanced-image runtime and Admin-managed configuration.
-- domain: app_core + admin
--
-- Business invariant:
--   Only the normal image-generation path remains configurable. The four
--   image_advanced_* keys must not be readable from runtime_config or writable
--   through Admin drafts/releases after this migration.
--
-- Authoritative writers:
--   app_core.runtime_config is the published runtime source; admin.config_drafts
--   and admin.config_releases hold the Admin editing and release lifecycle.
--
-- Compatibility:
--   This migration deliberately keeps feature_free_trial_limits.basic_image,
--   media_feature_free_trial_limit (legacy), normal image_* keys, historical
--   image attempts/tiers, billing facts, and settlement functions unchanged.
--   Separate Admin audit events are retained; advanced config drafts/releases
--   are removed because their values must no longer be restorable or publishable.
--
-- Lock/capacity:
--   Deletes at most the rows for four config keys and adds two small CHECK
--   constraints. lock_timeout is 5s; stop and retry during a quiet window if an
--   Admin write holds either table. No backfill or table rewrite is intended.
--
-- Release order:
--   Deploy application code that no longer reads/writes advanced image config,
--   then execute this file once in test, verify, and separately approve prod.
--
-- Recovery / forward-fix:
--   Reinsert reviewed safe defaults into app_core.runtime_config, drop the two
--   *_no_advanced_image_config checks, and restore admin.is_managed_config_key /
--   admin.validate_managed_config_value plus the provider validator from
--   20260923_vip_strategy_media_limit_alignment.sql. Deleted Admin drafts and
--   releases are intentionally not reconstructed; recover them only from a
--   verified backup if business history must be restored.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('admin.config_drafts') IS NULL
     OR to_regclass('admin.config_releases') IS NULL
     OR to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '20260928_remove_advanced_image_config: required config objects are missing';
  END IF;

  -- A release for another key must never depend on an advanced-image draft or
  -- release. Stop rather than cascading across an unrelated configuration.
  IF EXISTS (
    SELECT 1
    FROM admin.config_releases AS dependent
    JOIN admin.config_drafts AS source
      ON source.id = dependent.source_draft_id
    WHERE source.config_key LIKE 'image_advanced_%'
      AND dependent.config_key NOT LIKE 'image_advanced_%'
  ) OR EXISTS (
    SELECT 1
    FROM admin.config_releases AS dependent
    JOIN admin.config_releases AS target
      ON target.id = dependent.rollback_of_release_id
    WHERE target.config_key LIKE 'image_advanced_%'
      AND dependent.config_key NOT LIKE 'image_advanced_%'
  ) THEN
    RAISE EXCEPTION '20260928_remove_advanced_image_config: cross-key Admin release dependency found';
  END IF;
END;
$$;

-- Break references only inside the selected retired release set. Cross-key
-- dependencies were rejected above. This makes the subsequent deletes safe for
-- both source_draft_id and rollback_of_release_id RESTRICT foreign keys.
UPDATE admin.config_releases
SET source_draft_id = NULL,
    rollback_of_release_id = NULL
WHERE config_key IN (
  'image_advanced_enabled',
  'image_advanced_generation_credits',
  'image_advanced_price_label',
  'image_advanced_provider_config'
);

DELETE FROM admin.config_releases
WHERE config_key IN (
  'image_advanced_enabled',
  'image_advanced_generation_credits',
  'image_advanced_price_label',
  'image_advanced_provider_config'
);

DELETE FROM admin.config_drafts
WHERE config_key IN (
  'image_advanced_enabled',
  'image_advanced_generation_credits',
  'image_advanced_price_label',
  'image_advanced_provider_config'
);

DELETE FROM app_core.runtime_config
WHERE key IN (
  'image_advanced_enabled',
  'image_advanced_generation_credits',
  'image_advanced_price_label',
  'image_advanced_provider_config'
);

-- Keep the existing positive allowlist checks untouched so later managed keys
-- are not accidentally lost. These exclusions contract only advanced-image
-- writes, including direct table writes that bypass Admin RPCs.
ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_no_advanced_image_config,
  ADD CONSTRAINT config_drafts_no_advanced_image_config CHECK (
    config_key NOT IN (
      'image_advanced_enabled',
      'image_advanced_generation_credits',
      'image_advanced_price_label',
      'image_advanced_provider_config'
    )
  );

ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_no_advanced_image_config,
  ADD CONSTRAINT config_releases_no_advanced_image_config CHECK (
    config_key NOT IN (
      'image_advanced_enabled',
      'image_advanced_generation_credits',
      'image_advanced_price_label',
      'image_advanced_provider_config'
    )
  );

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
    'image_text_model_config', 'image_prompt_policy', 'image_default_art_style',
    'image_description_system_prompt', 'image_width', 'image_height',
    'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint',
    'media_feature_free_trial_limit',
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config',
    'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits'
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
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
$$;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS admin.validate_image_advanced_provider_config(JSONB);

DO $$
DECLARE
  v_rejected BOOLEAN := FALSE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_core.runtime_config WHERE key LIKE 'image_advanced_%'
  ) OR EXISTS (
    SELECT 1 FROM admin.config_drafts WHERE config_key LIKE 'image_advanced_%'
  ) OR EXISTS (
    SELECT 1 FROM admin.config_releases WHERE config_key LIKE 'image_advanced_%'
  ) THEN
    RAISE EXCEPTION '20260928_remove_advanced_image_config: advanced config rows remain';
  END IF;

  IF admin.is_managed_config_key('image_advanced_enabled')
     OR NOT admin.is_managed_config_key('image_generation_enabled')
     OR NOT admin.is_managed_config_key('feature_free_trial_limits') THEN
    RAISE EXCEPTION '20260928_remove_advanced_image_config: managed-key self-check failed';
  END IF;

  PERFORM admin.validate_managed_config_value(
    'feature_free_trial_limits',
    '{"voice":3,"basic_image":3}'::jsonb,
    NULL
  );

  BEGIN
    PERFORM admin.validate_managed_config_value('image_advanced_enabled', 'false'::jsonb, NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION '20260928_remove_advanced_image_config: advanced validator was not rejected';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.is_managed_config_key(TEXT) IS
  'Returns the current Admin-managed runtime config allowlist; advanced image keys are retired.';
COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Validates current Admin runtime config values and rejects retired advanced image keys.';

COMMIT;

-- Test-environment verification after the workflow succeeds:
--   SELECT key FROM app_core.runtime_config WHERE key LIKE 'image_advanced_%'; -- 0 rows
--   SELECT config_key FROM admin.config_drafts WHERE config_key LIKE 'image_advanced_%'; -- 0 rows
--   SELECT config_key FROM admin.config_releases WHERE config_key LIKE 'image_advanced_%'; -- 0 rows
--   SELECT admin.is_managed_config_key('image_advanced_enabled'); -- false
--   SELECT admin.is_managed_config_key('image_generation_enabled'); -- true
--   SELECT admin.validate_managed_config_value(
--     'feature_free_trial_limits', '{"voice":3,"basic_image":3}'::jsonb, NULL
--   ); -- succeeds