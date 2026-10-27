-- domain: app_core / admin / miniapp_features
-- ENV: TEST ONLY (project ref zoqelpfhurwehlvypryl)
-- Forward-fix for check-in tiered rewards without narrowing managed-key allowlist.
-- Do NOT apply 20261014_checkin_tiered_rewards.sql on this environment (23514 / allowlist wipe).
--
-- Target: TEST zoqelpfhurwehlvypryl via Database Migration workflow only.
-- VIP absolute default 150 (product design from 20261014). Prefer existing number /
-- object.fixed_credits when present.
-- MCP cannot currently see TEST; run workflow inspect before apply.
-- Forbidden: force_rerun, Studio SQL Editor, applying production file here.
--
-- Pattern: rename-wrap is_managed_config_key / validate_managed_config_value (OR predecessor),
-- widen drafts/releases CHECK monotonically, convert VIP check-in object→absolute integer,
-- seed non-VIP tiers, replace claim_daily_checkin. One-shot; predecessor blocks rerun.
-- Lock: ACCESS EXCLUSIVE on admin.config_drafts/releases; lock_timeout 5s; statement 60s.
-- Recovery: whole transaction rolls back; after commit use new forward-fix, never restore
-- object-shaped vip_checkin_bonus_config validator or the narrow static allowlist.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_vip jsonb;
BEGIN
  IF to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_vip_checkin_bonus_config(jsonb)') IS NULL
     OR to_regprocedure('admin.assert_vip_json_int(jsonb,integer,integer,text)') IS NULL
     OR to_regprocedure('miniapp_features.claim_daily_checkin(uuid)') IS NULL
     OR to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NULL
     OR to_regclass('admin.config_drafts') IS NULL
     OR to_regclass('admin.config_releases') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL THEN
    RAISE EXCEPTION 'checkin tiers (test): required objects missing';
  END IF;
  IF to_regprocedure('admin.is_managed_config_key_before_checkin_tiers(text)') IS NOT NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_checkin_tiers(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'checkin tiers (test): already applied (predecessor exists)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'admin.is_managed_config_key(text)'::regprocedure
      AND p.prorettype = 'boolean'::regtype AND NOT p.proretset
      AND NOT p.prosecdef AND p.provolatile = 'i' AND p.proparallel = 's'
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'checkin tiers (test): unexpected managed-key function shape/owner';
  END IF;
  IF admin.is_managed_config_key('miniapp_checkin_new_user_credits')
     AND admin.is_managed_config_key('reply_style_options') IS DISTINCT FROM true
     AND EXISTS (
       SELECT 1 FROM admin.config_drafts WHERE config_key = 'reply_style_options'
     ) THEN
    RAISE EXCEPTION 'checkin tiers (test): narrow allowlist already active with reply_style drafts; stop';
  END IF;
  SELECT value INTO v_vip FROM app_core.runtime_config WHERE key = 'vip_checkin_bonus_config';
  IF v_vip IS NOT NULL
     AND jsonb_typeof(v_vip) = 'number'
     AND EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key = 'miniapp_checkin_new_user_credits')
     AND EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key = 'miniapp_checkin_veteran_credits') THEN
    RAISE EXCEPTION 'checkin tiers (test): runtime seeds already present; stop (do not force_rerun)';
  END IF;
END
$preflight$;

LOCK TABLE admin.config_drafts, admin.config_releases IN ACCESS EXCLUSIVE MODE;

ALTER FUNCTION admin.is_managed_config_key(TEXT)
  RENAME TO is_managed_config_key_before_checkin_tiers;

CREATE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT p_config_key IN (
    'miniapp_checkin_new_user_credits',
    'miniapp_checkin_veteran_credits'
  ) OR admin.is_managed_config_key_before_checkin_tiers(p_config_key)
$fn$;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key_before_checkin_tiers(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

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

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_checkin_tiers;

CREATE FUNCTION admin.validate_managed_config_value(
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

REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_checkin_tiers(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_checkin_bonus_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

DO $widen_checks$
DECLARE
  v_table REGCLASS;
  v_name TEXT;
  v_expression TEXT;
  v_validated BOOLEAN;
  v_key TEXT;
  v_allowed BOOLEAN;
  v_keys CONSTANT TEXT[] := ARRAY[
    'miniapp_checkin_new_user_credits',
    'miniapp_checkin_veteran_credits',
    'reply_style_options',
    'vip_checkin_bonus_config'
  ];
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::regclass, 'admin.config_releases'::regclass
  ] LOOP
    v_name := CASE v_table
      WHEN 'admin.config_drafts'::regclass THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_expr(c.conbin, c.conrelid), c.convalidated
      INTO v_expression, v_validated
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'checkin tiers (test): missing constraint %.%', v_table, v_name;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
      v_table, v_name, v_expression,
      CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
    );

    SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_expression
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c'
      AND c.convalidated = v_validated;
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'checkin tiers (test): constraint validation state changed';
    END IF;

    FOREACH v_key IN ARRAY v_keys LOOP
      IF v_key = 'reply_style_options'
         AND NOT admin.is_managed_config_key_before_checkin_tiers(v_key)
         AND NOT EXISTS (
           SELECT 1 FROM admin.config_drafts d WHERE d.config_key = v_key
           UNION ALL
           SELECT 1 FROM admin.config_releases r WHERE r.config_key = v_key
         ) THEN
        CONTINUE;
      END IF;
      EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
        INTO v_allowed USING v_key;
      IF v_allowed IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'checkin tiers (test): key % rejected by %', v_key, v_table;
      END IF;
    END LOOP;

    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING '__unknown_config_key__';
    IF v_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'checkin tiers (test): unknown key not rejected by %', v_table;
    END IF;
  END LOOP;
END
$widen_checks$;

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
  value = CASE
    WHEN jsonb_typeof(value) = 'number'
         AND (value #>> '{}') ~ '^[0-9]+$'
      THEN value
    WHEN jsonb_typeof(value) = 'object'
         AND value->>'mode' = 'fixed'
         AND (value->>'fixed_credits') ~ '^[0-9]+$'
      THEN to_jsonb((value->>'fixed_credits')::integer)
    ELSE '150'::jsonb
  END,
  description = 'VIP 每日签到专项星尘绝对额（非加成）。',
  version = COALESCE(version, 0) + 1,
  updated_at = now()
WHERE key = 'vip_checkin_bonus_config';

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at)
SELECT
  'vip_checkin_bonus_config',
  '150'::jsonb,
  'VIP 每日签到专项星尘绝对额（非加成）。',
  1,
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM app_core.runtime_config WHERE key = 'vip_checkin_bonus_config'
);

UPDATE admin.config_drafts
SET
  value = CASE
    WHEN jsonb_typeof(value) = 'number'
         AND (value #>> '{}') ~ '^[0-9]+$'
      THEN value
    WHEN jsonb_typeof(value) = 'object'
         AND value->>'mode' = 'fixed'
         AND (value->>'fixed_credits') ~ '^[0-9]+$'
      THEN to_jsonb((value->>'fixed_credits')::integer)
    ELSE '150'::jsonb
  END,
  updated_at = now()
WHERE config_key = 'vip_checkin_bonus_config'
  AND value IS NOT NULL
  AND jsonb_typeof(value) IS DISTINCT FROM 'number';

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

DO $selfcheck$
DECLARE
  v_rejected BOOLEAN := false;
  v_vip jsonb;
  v_key TEXT;
BEGIN
  IF NOT admin.is_managed_config_key('miniapp_checkin_new_user_credits')
     OR NOT admin.is_managed_config_key('miniapp_checkin_veteran_credits') THEN
    RAISE EXCEPTION 'checkin tiers (test): managed-key allowlist self-check failed';
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'vip_checkin_bonus_config', 'llm_model_catalog', 'system_instructions'
  ] LOOP
    IF admin.is_managed_config_key(v_key) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'checkin tiers (test): lost managed key %', v_key;
    END IF;
  END LOOP;

  IF admin.is_managed_config_key('__unknown_config_key__') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'checkin tiers (test): unknown key accepted';
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
    RAISE EXCEPTION 'checkin tiers (test): legacy vip object config was accepted';
  END IF;

  IF (SELECT value FROM app_core.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits')
       IS DISTINCT FROM '0'::jsonb THEN
    RAISE EXCEPTION 'checkin tiers (test): legacy base seed self-check failed';
  END IF;

  SELECT value INTO v_vip FROM app_core.runtime_config WHERE key = 'vip_checkin_bonus_config';
  IF jsonb_typeof(v_vip) IS DISTINCT FROM 'number'
     OR (v_vip #>> '{}') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'checkin tiers (test): vip absolute seed self-check failed: %', v_vip;
  END IF;

  IF (SELECT value FROM app_core.runtime_config WHERE key = 'miniapp_checkin_new_user_credits')
       IS DISTINCT FROM '60'::jsonb
     OR (SELECT value FROM app_core.runtime_config WHERE key = 'miniapp_checkin_veteran_credits')
       IS DISTINCT FROM '15'::jsonb THEN
    RAISE EXCEPTION 'checkin tiers (test): tier seed self-check failed';
  END IF;
END
$selfcheck$;

NOTIFY pgrst, 'reload schema';
COMMIT;
