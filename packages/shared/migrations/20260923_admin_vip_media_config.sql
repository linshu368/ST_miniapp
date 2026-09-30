-- 20260923: expose VIP media config in Admin and make media free-trial limit configurable.
-- domain: app_core + admin + billing + experience
--
-- Run manually through the established migration workflow. Test first, then production.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('admin.config_drafts') IS NULL
     OR to_regclass('billing.feature_free_trials') IS NULL THEN
    RAISE EXCEPTION '20260923_admin_vip_media_config: required tables are missing';
  END IF;
  IF to_regprocedure('billing.reserve_feature_free_trial(uuid,text,text,integer)') IS NULL THEN
    RAISE EXCEPTION '20260923_admin_vip_media_config: reserve_feature_free_trial missing';
  END IF;
END;
$$;

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at, text_value)
VALUES
  ('media_feature_free_trial_limit', '3'::jsonb, 'Voice and basic image free successful trial count per feature.', 1, now(), NULL),
  ('image_advanced_enabled', 'false'::jsonb, 'Advanced image entry switch.', 1, now(), NULL),
  ('image_advanced_generation_credits', '120'::jsonb, 'Advanced image main-credit debit amount after successful generation.', 1, now(), NULL),
  ('image_advanced_price_label', '"120 星尘"'::jsonb, 'Advanced image price label shown in confirmation UI.', 1, now(), NULL),
  ('image_advanced_provider_config', '{}'::jsonb, 'Advanced image provider config. Empty object means unavailable.', 1, now(), NULL)
ON CONFLICT(key) DO NOTHING;

ALTER TABLE billing.feature_free_trials
  DROP CONSTRAINT IF EXISTS feature_free_trials_ordinal_check,
  ADD CONSTRAINT feature_free_trials_ordinal_check CHECK (ordinal BETWEEN 1 AND 100);

ALTER TABLE experience.chat_message_audio
  DROP CONSTRAINT IF EXISTS chat_message_audio_free_trial_ordinal_check,
  ADD CONSTRAINT chat_message_audio_free_trial_ordinal_check
    CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 100);

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_free_trial_ordinal_check,
  ADD CONSTRAINT chat_message_images_free_trial_ordinal_check
    CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 100),
  DROP CONSTRAINT IF EXISTS chat_message_images_current_requires_charged_ready,
  ADD CONSTRAINT chat_message_images_current_requires_charged_ready CHECK (
    NOT is_current
    OR (
      status = 'ready'
      AND (
        (
          billing_mode = 'free_trial'
          AND image_tier = 'basic'
          AND debit_ledger_id IS NULL
          AND credits_charged = 0
          AND free_trial_ordinal BETWEEN 1 AND 100
        )
        OR (
          billing_mode = 'paid'
          AND debit_ledger_id IS NOT NULL
          AND credits_charged > 0
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION billing.reserve_feature_free_trial(
  p_user_id UUID,
  p_feature TEXT,
  p_reference_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 900
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_reference TEXT;
  v_ttl INTEGER;
  v_limit INTEGER := 3;
  v_existing billing.feature_free_trials;
  v_ordinal INTEGER;
  v_row billing.feature_free_trials;
  v_used INTEGER;
  v_reserved INTEGER;
BEGIN
  v_reference := btrim(COALESCE(p_reference_id, ''));
  v_ttl := LEAST(GREATEST(COALESCE(p_ttl_seconds, 900), 30), 3600);

  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') OR v_reference = '' THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT CASE
      WHEN jsonb_typeof(value) = 'number'
       AND (value #>> '{}') ~ '^[0-9]+$'
       AND (value #>> '{}')::integer BETWEEN 1 AND 100
        THEN (value #>> '{}')::integer
      ELSE 3
    END
  INTO v_limit
  FROM app_core.runtime_config
  WHERE key = 'media_feature_free_trial_limit';
  v_limit := COALESCE(v_limit, 3);

  PERFORM pg_advisory_xact_lock(74210022, hashtext(p_user_id::text || ':' || p_feature));
  PERFORM billing.reclaim_expired_feature_free_trials(p_user_id, p_feature);

  SELECT *
  INTO v_existing
  FROM billing.feature_free_trials
  WHERE reference_id = v_reference
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.user_id = p_user_id AND v_existing.feature = p_feature THEN
    IF v_existing.status IN ('reserved', 'consumed') THEN
      SELECT
        count(*) FILTER (WHERE status = 'consumed' AND ordinal <= v_limit),
        count(*) FILTER (WHERE status = 'reserved' AND ordinal <= v_limit)
      INTO v_used, v_reserved
      FROM billing.feature_free_trials
      WHERE user_id = p_user_id
        AND feature = p_feature
        AND status IN ('reserved', 'consumed');

      RETURN jsonb_build_object(
        'ok', true,
        'status', CASE WHEN v_existing.status = 'consumed' THEN 'already_consumed' ELSE 'already_reserved' END,
        'fact', to_jsonb(v_existing),
        'quota', jsonb_build_object(
          'feature', p_feature,
          'free_trial_limit', v_limit,
          'free_trials_used', v_used,
          'free_trials_reserved', v_reserved,
          'free_trials_remaining', GREATEST(v_limit - v_used - v_reserved, 0),
          'next_trial_ordinal', NULL
        )
      );
    END IF;
  ELSIF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT MIN(ordinal)
  INTO v_ordinal
  FROM generate_series(1, v_limit) AS ordinal
  WHERE ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
      AND fft.ordinal <= v_limit
  );

  IF v_ordinal IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_EXHAUSTED',
      'message', 'free trial occupancy exceeds the account limit'
    );
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'released' THEN
    UPDATE billing.feature_free_trials
    SET
      ordinal = v_ordinal,
      status = 'reserved',
      reserved_until = now() + make_interval(secs => v_ttl),
      consumed_at = NULL,
      released_at = NULL,
      updated_at = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO billing.feature_free_trials (
      user_id,
      feature,
      reference_id,
      ordinal,
      status,
      reserved_until
    ) VALUES (
      p_user_id,
      p_feature,
      v_reference,
      v_ordinal,
      'reserved',
      now() + make_interval(secs => v_ttl)
    )
    RETURNING * INTO v_row;
  END IF;

  SELECT
    count(*) FILTER (WHERE status = 'consumed' AND ordinal <= v_limit),
    count(*) FILTER (WHERE status = 'reserved' AND ordinal <= v_limit)
  INTO v_used, v_reserved
  FROM billing.feature_free_trials
  WHERE user_id = p_user_id
    AND feature = p_feature
    AND status IN ('reserved', 'consumed');

  SELECT MIN(g.ordinal)
  INTO v_ordinal
  FROM generate_series(1, v_limit) AS g(ordinal)
  WHERE g.ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
      AND fft.ordinal <= v_limit
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'reserved',
    'fact', to_jsonb(v_row),
    'quota', jsonb_build_object(
      'feature', p_feature,
      'free_trial_limit', v_limit,
      'free_trials_used', v_used,
      'free_trials_reserved', v_reserved,
      'free_trials_remaining', GREATEST(v_limit - v_used - v_reserved, 0),
      'next_trial_ordinal', v_ordinal
    )
  );
END;
$$;

DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
  v_key TEXT;
  v_keys CONSTANT TEXT[] := ARRAY[
    'image_advanced_enabled',
    'image_advanced_generation_credits',
    'image_advanced_price_label',
    'image_advanced_provider_config',
    'media_feature_free_trial_limit'
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

    FOREACH v_key IN ARRAY v_keys LOOP
      IF position(v_key IN v_existing_expression) = 0 THEN
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
        v_existing_expression := format('(%s) OR config_key = %L', v_existing_expression, v_key);
        EXECUTE format(
          'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)',
          v_table,
          v_constraint_name,
          v_existing_expression
        );
      END IF;
    END LOOP;
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
    'llm_provider_routing_config', 'system_fallback_character_id', 'system_instructions',
    'pref_word_count_tiers', 'lobby_ranking_params', 'lobby_pinned_characters',
    'miniapp_invite_reward_rules', 'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_text_model_config', 'image_prompt_policy', 'image_default_art_style',
    'image_description_system_prompt', 'image_width', 'image_height', 'image_max_prompt_chars',
    'image_max_output_bytes', 'image_prompt_over_limit_hint', 'image_description_failed_hint',
    'image_generation_failed_hint', 'image_failed_unknown_hint', 'image_advanced_enabled',
    'image_advanced_generation_credits', 'image_advanced_price_label',
    'image_advanced_provider_config', 'media_feature_free_trial_limit'
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_image_advanced_provider_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_provider TEXT;
  v_model TEXT;
  v_keys TEXT[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'image_advanced_provider_config must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_value) AS key;

  IF array_length(v_keys, 1) IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_keys) AS key WHERE key NOT IN ('provider', 'model')
  ) THEN
    RAISE EXCEPTION 'image_advanced_provider_config only accepts provider and model'
      USING ERRCODE = '22023';
  END IF;

  v_provider := btrim(COALESCE(p_value ->> 'provider', ''));
  v_model := btrim(COALESCE(p_value ->> 'model', ''));

  IF v_provider = '' AND v_model = '' THEN
    RETURN;
  END IF;
  IF v_provider NOT IN ('liaobots_grok', 'replicate_z') THEN
    RAISE EXCEPTION 'image_advanced_provider_config has unsupported provider: %', v_provider
      USING ERRCODE = '22023';
  END IF;
  IF v_model = '' OR char_length(v_model) > 256 THEN
    RAISE EXCEPTION 'image_advanced_provider_config.model must be 1-256 characters'
      USING ERRCODE = '22023';
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
  IF p_config_key = 'image_description_system_prompt' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_description_system_prompt must store text in text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'image_description_system_prompt text_value must be nonempty'
        USING ERRCODE = '22023';
    END IF;
    IF char_length(p_text_value) > 12000 THEN
      RAISE EXCEPTION 'image_description_system_prompt is too long'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_text_value IS NOT NULL THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;

  IF p_config_key = 'llm_provider_routing_config' THEN
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'image_text_model_config' THEN
    PERFORM admin.validate_image_text_model_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'lobby_pinned_characters' THEN
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_center_config' THEN
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
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
    PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);
    RETURN;
  END IF;
  IF p_config_key = 'image_advanced_enabled' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'image_advanced_enabled must be a JSON boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'image_advanced_generation_credits' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'image_advanced_generation_credits must be a positive integer'
        USING ERRCODE = '22023';
    END IF;
    IF (p_value #>> '{}')::integer <= 0 THEN
      RAISE EXCEPTION 'image_advanced_generation_credits must be a positive integer'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'image_advanced_price_label' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string'
       OR char_length(btrim(p_value #>> '{}')) = 0
       OR char_length(btrim(p_value #>> '{}')) > 200 THEN
      RAISE EXCEPTION 'image_advanced_price_label must be a nonempty string up to 200 chars'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'image_advanced_provider_config' THEN
    PERFORM admin.validate_image_advanced_provider_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'media_feature_free_trial_limit' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'media_feature_free_trial_limit must be an integer between 1 and 100'
        USING ERRCODE = '22023';
    END IF;
    IF (p_value #>> '{}')::integer NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'media_feature_free_trial_limit must be an integer between 1 and 100'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key, p_value, p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_image_advanced_provider_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_key TEXT;
  v_definition TEXT;
  v_raised BOOLEAN := FALSE;
  v_keys CONSTANT TEXT[] := ARRAY[
    'image_advanced_enabled',
    'image_advanced_generation_credits',
    'image_advanced_price_label',
    'image_advanced_provider_config',
    'media_feature_free_trial_limit'
  ];
BEGIN
  FOREACH v_key IN ARRAY v_keys LOOP
    IF NOT EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key = v_key) THEN
      RAISE EXCEPTION 'self-check failed: missing runtime_config key %', v_key;
    END IF;
    IF NOT admin.is_managed_config_key(v_key) THEN
      RAISE EXCEPTION 'self-check failed: % is not managed', v_key;
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(c.oid)
    INTO v_definition
  FROM pg_constraint c
  WHERE c.conrelid = 'admin.config_drafts'::REGCLASS
    AND c.conname = 'config_drafts_config_key_check'
    AND c.contype = 'c';
  IF v_definition IS NULL OR position('media_feature_free_trial_limit' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'self-check failed: admin.config_drafts missing vip media keys';
  END IF;

  PERFORM admin.validate_managed_config_value('image_advanced_enabled', 'true'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('image_advanced_generation_credits', '120'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('image_advanced_price_label', '"120 星尘"'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value(
    'image_advanced_provider_config',
    '{"provider":"liaobots_grok","model":"grok-4-image"}'::jsonb,
    NULL
  );
  PERFORM admin.validate_managed_config_value('image_advanced_provider_config', '{}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('media_feature_free_trial_limit', '3'::jsonb, NULL);

  BEGIN
    PERFORM admin.validate_managed_config_value('media_feature_free_trial_limit', '101'::jsonb, NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: invalid free-trial limit accepted';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Rollback sketch:
--   Deploy code that no longer writes these Admin keys first.
--   Re-run billing.reserve_feature_free_trial from 20260921_feature_free_trial_checkin_reminder.sql.
--   Recreate ordinal constraints with BETWEEN 1 AND 3 only after confirming no rows > 3 exist.
--   Recreate admin.is_managed_config_key / admin.validate_managed_config_value from the previous migration.
--   DELETE FROM app_core.runtime_config WHERE key IN (...new keys...) only after all drafts/releases are cleaned.
