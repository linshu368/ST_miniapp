-- 20260923: align media free trials with the published per-feature VIP limits.
-- domain: billing + admin + experience
--
-- 20260923_admin_vip_media_config.sql sorts before 20260923_vip_strategy_config.sql,
-- but on test the strategy file is already applied. Applying the media file later
-- replaces reserve_feature_free_trial and the admin validators, and widens ordinals
-- to 100. This forward-fix runs after both. It does not edit those files.
--
-- Quota source stays feature_free_trial_limits (voice/basic_image, 0..20, missing = 3).
-- media_feature_free_trial_limit remains a legacy managed key and is not read by reserve.
-- Experience ordinal checks move to 1..20 so a raised limit can be stored.
-- Historical rows are kept. Rows above 20 stop the migration instead of being deleted.
--
-- Lock: short constraint rebuild and CREATE OR REPLACE FUNCTION.
-- lock_timeout 5s, statement_timeout 120s. No backfill.
-- Rollback: do not narrow ordinals back to 3 after a higher limit has been published.
-- Restore is another forward-fix, not a rewrite of the earlier files.
-- Do not apply this file to test or production from a local session.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('billing.feature_free_trials') IS NULL
     OR to_regprocedure('billing.reserve_feature_free_trial(uuid,text,text,integer)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_vip_strategy(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_feature_free_trial_limits(jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260923_vip_strategy_media_limit_alignment: VIP strategy primitives are missing';
  END IF;
  IF EXISTS (SELECT 1 FROM billing.feature_free_trials WHERE ordinal > 20) THEN
    RAISE EXCEPTION '20260923_vip_strategy_media_limit_alignment: feature_free_trials ordinal above 20';
  END IF;
END;
$$;

DO $$
DECLARE
  v_name TEXT;
  v_dropped INTEGER := 0;
BEGIN
  FOR v_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'billing.feature_free_trials'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~* '\mordinal\M'
  LOOP
    EXECUTE format('ALTER TABLE billing.feature_free_trials DROP CONSTRAINT %I', v_name);
    v_dropped := v_dropped + 1;
  END LOOP;
  IF v_dropped = 0 THEN
    RAISE EXCEPTION 'feature_free_trials ordinal check missing';
  END IF;
END;
$$;

ALTER TABLE billing.feature_free_trials
  ADD CONSTRAINT feature_free_trials_ordinal_check
  CHECK (ordinal BETWEEN 1 AND 20);

-- Experience checks only change when the media columns already exist.
-- A local billing harness without those tables must still be able to restore reserve.
DO $$
BEGIN
  IF to_regclass('experience.chat_message_audio') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'experience'
         AND table_name = 'chat_message_audio'
         AND column_name = 'free_trial_ordinal'
     ) THEN
    IF EXISTS (
      SELECT 1 FROM experience.chat_message_audio WHERE free_trial_ordinal > 20
    ) THEN
      RAISE EXCEPTION 'chat_message_audio free_trial_ordinal above 20';
    END IF;
    EXECUTE 'ALTER TABLE experience.chat_message_audio DROP CONSTRAINT IF EXISTS chat_message_audio_free_trial_ordinal_check';
    EXECUTE $sql$
      ALTER TABLE experience.chat_message_audio
      ADD CONSTRAINT chat_message_audio_free_trial_ordinal_check
      CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 20)
    $sql$;
  END IF;

  IF to_regclass('experience.chat_message_images') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'experience'
         AND table_name = 'chat_message_images'
         AND column_name = 'free_trial_ordinal'
     )
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'experience'
         AND table_name = 'chat_message_images'
         AND column_name = 'is_current'
     ) THEN
    IF EXISTS (
      SELECT 1 FROM experience.chat_message_images WHERE free_trial_ordinal > 20
    ) THEN
      RAISE EXCEPTION 'chat_message_images free_trial_ordinal above 20';
    END IF;
    EXECUTE 'ALTER TABLE experience.chat_message_images DROP CONSTRAINT IF EXISTS chat_message_images_free_trial_ordinal_check';
    EXECUTE $sql$
      ALTER TABLE experience.chat_message_images
      ADD CONSTRAINT chat_message_images_free_trial_ordinal_check
      CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 20)
    $sql$;
    EXECUTE 'ALTER TABLE experience.chat_message_images DROP CONSTRAINT IF EXISTS chat_message_images_current_requires_charged_ready';
    EXECUTE $sql$
      ALTER TABLE experience.chat_message_images
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
              AND free_trial_ordinal BETWEEN 1 AND 20
            )
            OR (
              billing_mode = 'paid'
              AND debit_ledger_id IS NOT NULL
              AND credits_charged > 0
            )
          )
        )
      )
    $sql$;
  END IF;
END;
$$;

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
  v_existing billing.feature_free_trials;
  v_ordinal INTEGER;
  v_row billing.feature_free_trials;
  v_used INTEGER;
  v_reserved INTEGER;
  v_occupied INTEGER;
  v_limit INTEGER := 3;
  v_limits JSONB;
  v_raw JSONB;
  v_text TEXT;
  v_next INTEGER;
BEGIN
  v_reference := btrim(COALESCE(p_reference_id, ''));
  v_ttl := LEAST(GREATEST(COALESCE(p_ttl_seconds, 900), 30), 3600);

  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') OR v_reference = '' THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(74210022, hashtext(p_user_id::text || ':' || p_feature));
  PERFORM billing.reclaim_expired_feature_free_trials(p_user_id, p_feature);

  SELECT value INTO v_limits
  FROM app_core.runtime_config
  WHERE key = 'feature_free_trial_limits';
  IF v_limits IS NOT NULL AND jsonb_typeof(v_limits) = 'object' THEN
    v_raw := v_limits -> p_feature;
    IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) = 'number' THEN
      v_text := v_raw #>> '{}';
      IF v_text ~ '^(0|[1-9]|1[0-9]|20)$' THEN
        v_limit := v_text::integer;
      END IF;
    END IF;
  END IF;

  SELECT *
  INTO v_existing
  FROM billing.feature_free_trials
  WHERE reference_id = v_reference
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.user_id = p_user_id AND v_existing.feature = p_feature THEN
    IF v_existing.status IN ('reserved', 'consumed') THEN
      SELECT
        count(*) FILTER (WHERE status = 'consumed'),
        count(*) FILTER (WHERE status = 'reserved')
      INTO v_used, v_reserved
      FROM billing.feature_free_trials
      WHERE user_id = p_user_id AND feature = p_feature AND status IN ('reserved', 'consumed');

      SELECT MIN(g.ordinal)
      INTO v_next
      FROM generate_series(1, 20) AS g(ordinal)
      WHERE g.ordinal NOT IN (
        SELECT fft.ordinal
        FROM billing.feature_free_trials AS fft
        WHERE fft.user_id = p_user_id
          AND fft.feature = p_feature
          AND fft.status IN ('reserved', 'consumed')
      );

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
          'next_trial_ordinal', CASE WHEN v_used + v_reserved < v_limit THEN v_next ELSE NULL END
        )
      );
    END IF;
  ELSIF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
  INTO v_occupied
  FROM billing.feature_free_trials
  WHERE user_id = p_user_id
    AND feature = p_feature
    AND status IN ('reserved', 'consumed');

  IF v_limit = 0 OR v_occupied >= v_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_EXHAUSTED',
      'message', 'free trial occupancy exceeds the account limit'
    );
  END IF;

  SELECT MIN(ordinal)
  INTO v_ordinal
  FROM generate_series(1, 20) AS ordinal
  WHERE ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
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
    count(*) FILTER (WHERE status = 'consumed'),
    count(*) FILTER (WHERE status = 'reserved')
  INTO v_used, v_reserved
  FROM billing.feature_free_trials
  WHERE user_id = p_user_id AND feature = p_feature AND status IN ('reserved', 'consumed');

  SELECT MIN(g.ordinal)
  INTO v_next
  FROM generate_series(1, 20) AS g(ordinal)
  WHERE g.ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
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
      'next_trial_ordinal', CASE WHEN v_used + v_reserved < v_limit THEN v_next ELSE NULL END
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER) IS
  '为 voice/basic_image 预留免费名额。上限在事务内读取 feature_free_trial_limits，缺省为 3，0 不分配。仅 service_role。';

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
    'image_advanced_enabled', 'image_advanced_generation_credits',
    'image_advanced_price_label', 'image_advanced_provider_config',
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
  IF p_config_key IN (
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config',
    'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits',
    'image_advanced_enabled', 'image_advanced_generation_credits',
    'image_advanced_price_label', 'image_advanced_provider_config',
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
  IF p_config_key = 'image_advanced_enabled' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'image_advanced_enabled must be a JSON boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'image_advanced_generation_credits' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}') !~ '^[0-9]+$'
       OR (p_value #>> '{}')::integer <= 0 THEN
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

  PERFORM admin.validate_managed_config_value_before_vip_strategy(p_config_key, p_value, p_text_value);
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_image_advanced_provider_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_def TEXT;
  v_ordinal TEXT;
  v_raised BOOLEAN := FALSE;
BEGIN
  SELECT pg_get_functiondef('billing.reserve_feature_free_trial(uuid,text,text,integer)'::regprocedure)
    INTO v_def;
  IF position('feature_free_trial_limits' IN v_def) = 0
     OR position('media_feature_free_trial_limit' IN v_def) > 0 THEN
    RAISE EXCEPTION 'self-check failed: reserve does not read feature_free_trial_limits';
  END IF;

  IF NOT admin.is_managed_config_key('feature_free_trial_limits')
     OR NOT admin.is_managed_config_key('image_advanced_enabled')
     OR NOT admin.is_managed_config_key('vip_plans_config') THEN
    RAISE EXCEPTION 'self-check failed: managed config key union is incomplete';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO v_ordinal
  FROM pg_constraint
  WHERE conrelid = 'billing.feature_free_trials'::regclass
    AND conname = 'feature_free_trials_ordinal_check';
  IF v_ordinal IS NULL OR position('20' IN v_ordinal) = 0 THEN
    RAISE EXCEPTION 'self-check failed: feature_free_trials ordinal is not 1..20';
  END IF;

  PERFORM admin.validate_managed_config_value(
    'feature_free_trial_limits',
    '{"voice":0,"basic_image":20}'::jsonb,
    NULL
  );
  PERFORM admin.validate_managed_config_value('image_advanced_enabled', 'false'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('image_advanced_provider_config', '{}'::jsonb, NULL);

  BEGIN
    PERFORM admin.validate_managed_config_value(
      'feature_free_trial_limits',
      '{"voice":21,"basic_image":3}'::jsonb,
      NULL
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: limit above 20 was accepted';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';
