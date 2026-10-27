-- domain: app_core / admin / miniapp_features
-- Check-in rewards: VIP absolute amount + non-VIP registration-age tiers.
-- Legacy miniapp_daily_checkin_bonus_credits is kept (default 0) but claim no longer reads it.
--
-- Release order: apply in TEST, deploy consumers, verify Admin publish + claim paths,
-- then apply in Production. This migration does not apply itself remotely.
--
-- Recovery: forward-fix validator/RPC with a reviewed migration; do not rewrite history.
-- Roll back behavior only by restoring prior claim_daily_checkin + validators via a new file.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_vip_checkin_bonus_config(jsonb)') IS NULL
     OR to_regprocedure('miniapp_features.claim_daily_checkin(uuid)') IS NULL
     OR to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'checkin tiered rewards: required procedures missing';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_checkin_tiers(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'checkin tiered rewards: validator predecessor already exists';
  END IF;
END
$preflight$;

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_checkin_tiers;

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits', 'miniapp_daily_checkin_bonus_credits',
    'miniapp_checkin_new_user_credits', 'miniapp_checkin_veteran_credits',
    'miniapp_character_free_chat_quota_limit', 'miniapp_payment_plans',
    'miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config', 'llm_model_catalog', 'llm_pricing_config',
    'llm_provider_routing_config', 'system_fallback_character_id', 'system_instructions',
    'choice_rules', 'status_rules', 'memory_rules', 'pref_word_count_tiers',
    'lobby_ranking_params', 'lobby_pinned_characters', 'miniapp_invite_reward_rules',
    'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_text_model_config', 'image_prompt_policy', 'image_default_art_style',
    'image_description_system_prompt', 'image_width', 'image_height',
    'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint',
    'media_feature_free_trial_limit', 'vip_purchase_enabled', 'vip_reminders_enabled',
    'vip_plans_config', 'vip_text_discount_rate', 'vip_checkin_bonus_config',
    'feature_free_trial_limits'
  );
$fn$;

-- VIP 签到改为绝对非负整数（与 vip_text_discount_rate 同类数值键）。
CREATE OR REPLACE FUNCTION admin.validate_vip_checkin_bonus_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.assert_vip_json_int(p_value, 0, 1000000, 'vip_checkin_bonus_config');
END;
$$;

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
  IF p_config_key IN (
    'miniapp_checkin_new_user_credits',
    'miniapp_checkin_veteran_credits'
  ) THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}') !~ '^[0-9]+$'
       OR (p_value #>> '{}')::integer > 1000000 THEN
      RAISE EXCEPTION '% must be a nonnegative integer JSON number', p_config_key
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_checkin_tiers(
    p_config_key, p_value, p_text_value
  );
END;
$fn$;

ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check,
  ADD CONSTRAINT config_drafts_config_key_check CHECK (
    admin.is_managed_config_key(config_key)
    OR config_key = 'miniapp_text_postprocess_config'
  );
ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check,
  ADD CONSTRAINT config_releases_config_key_check CHECK (
    admin.is_managed_config_key(config_key)
    OR config_key = 'miniapp_text_postprocess_config'
  );

-- Seed / migrate published values.
INSERT INTO app_core.runtime_config(key, value, description, version, updated_at)
VALUES
  (
    'miniapp_checkin_new_user_credits',
    '60'::jsonb,
    '非 VIP 且注册≤14 天的每日签到专项星尘。',
    1,
    now()
  ),
  (
    'miniapp_checkin_veteran_credits',
    '15'::jsonb,
    '非 VIP 且注册>14 天的每日签到专项星尘。',
    1,
    now()
  )
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

UPDATE app_core.runtime_config
SET
  value = '0'::jsonb,
  description = '遗留全员基础签到星尘；已由分档配置取代，发奖不再读取。保留键兼容 Admin。',
  version = COALESCE(version, 0) + 1,
  updated_at = now()
WHERE key = 'miniapp_daily_checkin_bonus_credits';

UPDATE app_core.runtime_config
SET
  value = '150'::jsonb,
  description = 'VIP 每日签到专项星尘绝对额（非加成）。',
  version = COALESCE(version, 0) + 1,
  updated_at = now()
WHERE key = 'vip_checkin_bonus_config';

-- Convert in-flight drafts from legacy bonus object to absolute integer.
UPDATE admin.config_drafts
SET
  value = '150'::jsonb,
  updated_at = now()
WHERE config_key = 'vip_checkin_bonus_config'
  AND jsonb_typeof(value) = 'object';

UPDATE admin.config_drafts
SET
  value = '0'::jsonb,
  updated_at = now()
WHERE config_key = 'miniapp_daily_checkin_bonus_credits'
  AND value IS DISTINCT FROM '0'::jsonb;

CREATE OR REPLACE FUNCTION miniapp_features.claim_daily_checkin(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_claimed_at timestamptz := clock_timestamp();
  v_last_claimed_at timestamptz;
  v_created_at timestamptz;
  v_age_days integer;
  v_base integer := 0;
  v_vip integer := 0;
  v_total integer;
  v_tier text;
  v_grant record;
  v_ledger_id uuid;
  v_wallet billing.user_wallets;
  v_membership billing.vip_memberships;
  v_vip_active boolean := false;
  v_vip_config jsonb;
  v_vip_version integer;
  v_new_user_credits integer;
  v_veteran_credits integer;
  v_vip_credits integer;
  v_fallback boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'daily check-in user is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(74210021, hashtext(p_user_id::text));

  SELECT created_at
  INTO v_created_at
  FROM app_core.users
  WHERE id = p_user_id
  FOR SHARE;

  IF NOT FOUND OR v_created_at IS NULL THEN
    RAISE EXCEPTION 'daily check-in user not found: %', p_user_id
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_vip_active := FOUND AND v_membership.valid_until > v_claimed_at;

  SELECT claimed_at
  INTO v_last_claimed_at
  FROM miniapp_features.daily_checkins
  WHERE user_id = p_user_id
  ORDER BY claimed_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_last_claimed_at > v_claimed_at - interval '24 hours' THEN
    RAISE EXCEPTION 'daily check-in is not ready: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  v_age_days := floor(EXTRACT(EPOCH FROM (v_claimed_at - v_created_at)) / 86400.0)::integer;
  IF v_age_days < 0 THEN
    v_age_days := 0;
  END IF;

  SELECT COALESCE(
    floor(
      COALESCE(
        (
          SELECT NULLIF(value #>> '{}', '')::numeric
          FROM app_core.runtime_config
          WHERE key = 'miniapp_checkin_new_user_credits'
        ),
        60
      )
    )::integer,
    60
  )
  INTO v_new_user_credits;

  SELECT COALESCE(
    floor(
      COALESCE(
        (
          SELECT NULLIF(value #>> '{}', '')::numeric
          FROM app_core.runtime_config
          WHERE key = 'miniapp_checkin_veteran_credits'
        ),
        15
      )
    )::integer,
    15
  )
  INTO v_veteran_credits;

  SELECT value, version
  INTO v_vip_config, v_vip_version
  FROM app_core.runtime_config
  WHERE key = 'vip_checkin_bonus_config';

  IF v_vip_config IS NULL
     OR jsonb_typeof(v_vip_config) IS DISTINCT FROM 'number'
     OR (v_vip_config #>> '{}') !~ '^[0-9]+$'
     OR char_length(v_vip_config #>> '{}') > 7 THEN
    v_fallback := true;
    v_vip_credits := 150;
  ELSE
    v_vip_credits := (v_vip_config #>> '{}')::integer;
    IF v_vip_credits < 0 OR v_vip_credits > 1000000 THEN
      v_fallback := true;
      v_vip_credits := 150;
    END IF;
  END IF;

  IF v_vip_active THEN
    v_tier := 'vip';
    v_base := 0;
    v_vip := v_vip_credits;
  ELSIF v_age_days <= 14 THEN
    v_tier := 'new_user';
    v_base := v_new_user_credits;
    v_vip := 0;
  ELSE
    v_tier := 'veteran';
    v_base := v_veteran_credits;
    v_vip := 0;
  END IF;

  v_total := v_base + v_vip;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'daily check-in reward must be positive: %', v_total
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id,
    v_total,
    'checkin_bonus',
    'daily_checkin',
    p_user_id::text,
    jsonb_build_object(
      'claimed_at', v_claimed_at,
      'base_reward_credits', v_base,
      'vip_reward_credits', v_vip,
      'reward_tier', v_tier,
      'registration_age_days', v_age_days,
      'vip_active', v_vip_active,
      'vip_valid_until', CASE WHEN v_vip_active THEN v_membership.valid_until ELSE NULL END,
      'vip_checkin_config_version', v_vip_version,
      'vip_checkin_config_fallback', v_fallback
    )
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  INSERT INTO miniapp_features.daily_checkins (
    user_id,
    reward_credits,
    claimed_at
  ) VALUES (
    p_user_id,
    v_total,
    v_claimed_at
  );

  RETURN jsonb_build_object(
    'wallet', to_jsonb(v_wallet),
    'checkin', jsonb_build_object(
      'claimed_at', v_claimed_at,
      'next_claim_at', v_claimed_at + interval '24 hours',
      'reward_credits', v_total,
      'base_reward_credits', v_base,
      'vip_reward_credits', v_vip,
      'vip_active', v_vip_active,
      'reward_tier', v_tier,
      'registration_age_days', v_age_days,
      'wallet_ledger_id', v_ledger_id,
      'vip_checkin_config_version', v_vip_version,
      'vip_checkin_config_fallback', v_fallback
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp_features.claim_daily_checkin(UUID)
  TO postgres, service_role, anon, authenticated;

COMMENT ON FUNCTION miniapp_features.claim_daily_checkin(UUID) IS
  '每日签到。VIP 发绝对额；非 VIP 按注册天数分新用户/老用户两档。旧全员基础键不再读取。';

REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_checkin_tiers(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_checkin_bonus_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

DO $selfcheck$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  IF NOT admin.is_managed_config_key('miniapp_checkin_new_user_credits')
     OR NOT admin.is_managed_config_key('miniapp_checkin_veteran_credits') THEN
    RAISE EXCEPTION 'checkin tiers: managed-key allowlist self-check failed';
  END IF;

  PERFORM admin.validate_managed_config_value('vip_checkin_bonus_config', '150'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('miniapp_checkin_new_user_credits', '60'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('miniapp_checkin_veteran_credits', '15'::jsonb, NULL);

  BEGIN
    PERFORM admin.validate_managed_config_value(
      'vip_checkin_bonus_config',
      '{"mode":"same_as_base"}'::jsonb,
      NULL
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'checkin tiers: legacy vip object config was accepted';
  END IF;

  IF (SELECT value FROM app_core.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits')
       IS DISTINCT FROM '0'::jsonb
     OR (SELECT value FROM app_core.runtime_config WHERE key = 'vip_checkin_bonus_config')
       IS DISTINCT FROM '150'::jsonb THEN
    RAISE EXCEPTION 'checkin tiers: seed values self-check failed';
  END IF;
END
$selfcheck$;

COMMIT;
NOTIFY pgrst, 'reload schema';
