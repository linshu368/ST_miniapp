-- 035: Scoped admin runtime-config management.
--
-- All writes are exposed through SECURITY DEFINER functions. The caller identity
-- is always resolved from auth.uid() and admin.admin_users; actor data is never
-- accepted from the client.
--
-- REQUIRED POST-MIGRATION BOOTSTRAP (run as service_role or postgres, once per DB):
--   Test DB:
--     INSERT INTO admin.environment_config (id, environment)
--     VALUES (1, 'test')
--     ON CONFLICT (id) DO UPDATE
--       SET environment = EXCLUDED.environment, updated_at = now();
--   Production DB:
--     INSERT INTO admin.environment_config (id, environment)
--     VALUES (1, 'production')
--     ON CONFLICT (id) DO UPDATE
--       SET environment = EXCLUDED.environment, updated_at = now();
-- Do not execute both statements against the same database. Authenticated reads
-- and mutations intentionally fail closed until this singleton is configured.

BEGIN;

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.environment_config (
  id           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  environment  TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin.admin_users (
  user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email            TEXT NOT NULL CHECK (char_length(trim(email)) > 0),
  role             TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  can_access_test  BOOLEAN NOT NULL DEFAULT true,
  can_access_prod  BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin.audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID REFERENCES admin.admin_users(user_id) ON DELETE SET NULL,
  actor_email    TEXT NOT NULL,
  environment    TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  action         TEXT NOT NULL,
  schema_name    TEXT NOT NULL,
  table_name     TEXT NOT NULL,
  record_id      TEXT NOT NULL,
  before_value   JSONB,
  after_value    JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin.config_drafts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment    TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  config_key     TEXT NOT NULL CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_payment_plans',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  )),
  value          JSONB,
  text_value     TEXT,
  description    TEXT,
  base_version   INTEGER NOT NULL DEFAULT 0 CHECK (base_version >= 0),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by     UUID NOT NULL REFERENCES admin.admin_users(user_id) ON DELETE RESTRICT,
  updated_by     UUID NOT NULL REFERENCES admin.admin_users(user_id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  CHECK (value IS NOT NULL OR text_value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS admin.config_releases (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment             TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  config_key              TEXT NOT NULL CONSTRAINT config_releases_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_payment_plans',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  )),
  runtime_version         INTEGER NOT NULL CHECK (runtime_version > 0),
  value                   JSONB,
  text_value              TEXT,
  description             TEXT,
  source_draft_id         UUID REFERENCES admin.config_drafts(id) ON DELETE RESTRICT,
  rollback_of_release_id  UUID REFERENCES admin.config_releases(id) ON DELETE RESTRICT,
  released_by             UUID NOT NULL REFERENCES admin.admin_users(user_id) ON DELETE RESTRICT,
  released_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (value IS NOT NULL OR text_value IS NOT NULL),
  CHECK (rollback_of_release_id IS NULL OR rollback_of_release_id <> id),
  UNIQUE (environment, config_key, runtime_version)
);

-- Recreate the managed-key constraints so rerunning this updated migration also
-- widens databases that may have received an earlier revision of migration 035.
ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_payment_plans',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  ));

ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases
  ADD CONSTRAINT config_releases_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_payment_plans',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_lower
  ON admin.admin_users (lower(email));

CREATE INDEX IF NOT EXISTS idx_admin_users_role
  ON admin.admin_users (role);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_environment_created
  ON admin.audit_logs (environment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor_created
  ON admin.audit_logs (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_config_drafts_lookup
  ON admin.config_drafts (environment, config_key, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_config_drafts_creator
  ON admin.config_drafts (created_by, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_config_releases_source_draft
  ON admin.config_releases (source_draft_id)
  WHERE source_draft_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_config_releases_lookup
  ON admin.config_releases (environment, config_key, released_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_config_releases_rollback
  ON admin.config_releases (rollback_of_release_id)
  WHERE rollback_of_release_id IS NOT NULL;

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
    'miniapp_payment_plans',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  );
$$;

CREATE OR REPLACE FUNCTION admin.current_environment()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_environment TEXT;
BEGIN
  SELECT config.environment
  INTO v_environment
  FROM admin.environment_config AS config
  WHERE config.id = 1;

  IF NOT FOUND OR v_environment NOT IN ('test', 'production') THEN
    RAISE EXCEPTION 'admin environment is not configured'
      USING
        ERRCODE = '55000',
        HINT = 'Bootstrap admin.environment_config as service_role or postgres.';
  END IF;

  RETURN v_environment;
END;
$$;

CREATE OR REPLACE FUNCTION admin.is_registered_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_environment TEXT;
BEGIN
  v_environment := admin.current_environment();

  RETURN EXISTS (
    SELECT 1
    FROM admin.admin_users AS au
    WHERE au.user_id = auth.uid()
      AND (
        (v_environment = 'test' AND au.can_access_test)
        OR (v_environment = 'production' AND au.can_access_prod)
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin.can_access_environment(p_environment TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM admin.admin_users AS au
    WHERE au.user_id = auth.uid()
      AND p_environment = admin.current_environment()
      AND (
        (p_environment = 'test' AND au.can_access_test)
        OR (p_environment = 'production' AND au.can_access_prod)
      )
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key  TEXT,
  p_value       JSONB,
  p_text_value  TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_uuid UUID;
BEGIN
  IF admin.is_managed_config_key(p_config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key
      USING ERRCODE = '22023';
  END IF;

  CASE
    WHEN p_config_key IN (
      'miniapp_new_user_signup_bonus_credits',
      'miniapp_daily_checkin_bonus_credits'
    ) THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC < 0 THEN
        RAISE EXCEPTION '% must be a nonnegative JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'miniapp_payment_plans' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_value) = 0 THEN
        RAISE EXCEPTION 'miniapp_payment_plans must be a nonempty JSON array'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value) AS plan
        WHERE jsonb_typeof(plan) IS DISTINCT FROM 'object'
          OR COALESCE(char_length(trim(plan ->> 'id')), 0) = 0
          OR jsonb_typeof(plan -> 'price_cents') IS DISTINCT FROM 'number'
          OR jsonb_typeof(plan -> 'credits_amount') IS DISTINCT FROM 'number'
          OR jsonb_typeof(plan -> 'bonus_credits') IS DISTINCT FROM 'number'
          OR CASE
               WHEN jsonb_typeof(plan -> 'price_cents') = 'number'
               THEN (plan ->> 'price_cents')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(plan -> 'credits_amount') = 'number'
               THEN (plan ->> 'credits_amount')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(plan -> 'bonus_credits') = 'number'
               THEN (plan ->> 'bonus_credits')::NUMERIC < 0
               ELSE true
             END
          OR COALESCE(plan ->> 'variant', '') NOT IN (
            'entry', 'standard', 'recommended', 'premium'
          )
      ) THEN
        RAISE EXCEPTION 'miniapp_payment_plans contains an invalid plan'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'llm_model_catalog' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_value -> 'tiers') = 0
         OR jsonb_typeof(p_value -> 'default_model_id') IS DISTINCT FROM 'string'
         OR COALESCE(char_length(trim(p_value ->> 'default_model_id')), 0) = 0 THEN
        RAISE EXCEPTION 'llm_model_catalog must include nonempty tiers and default_model_id'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        WHERE jsonb_typeof(tier) IS DISTINCT FROM 'object'
          OR COALESCE(tier ->> 'tier', '') NOT IN ('light', 'standard', 'premium')
          OR COALESCE(char_length(trim(tier ->> 'label')), 0) = 0
          OR COALESCE(char_length(trim(tier ->> 'color')), 0) = 0
          OR jsonb_typeof(tier -> 'sort_order') IS DISTINCT FROM 'number'
          OR jsonb_typeof(tier -> 'models') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF (
        SELECT count(*) <> count(DISTINCT tier ->> 'tier')
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog tier keys must be unique'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
        WHERE jsonb_typeof(model) IS DISTINCT FROM 'object'
          OR COALESCE(char_length(trim(model ->> 'id')), 0) = 0
          OR COALESCE(char_length(trim(model ->> 'openrouter_model_id')), 0) = 0
          OR COALESCE(char_length(trim(model ->> 'display_name')), 0) = 0
          OR char_length(COALESCE(model ->> 'tagline', '')) > 15
          OR jsonb_typeof(model -> 'price_input') IS DISTINCT FROM 'number'
          OR jsonb_typeof(model -> 'price_output') IS DISTINCT FROM 'number'
          OR jsonb_typeof(model -> 'enabled') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(model -> 'sort_order') IS DISTINCT FROM 'number'
          OR CASE
               WHEN jsonb_typeof(model -> 'price_input') = 'number'
               THEN (model ->> 'price_input')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(model -> 'price_output') = 'number'
               THEN (model ->> 'price_output')::NUMERIC < 0
               ELSE true
             END
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog contains an invalid model'
          USING ERRCODE = '22023';
      END IF;

      IF (
        SELECT count(*) <> count(DISTINCT model ->> 'id')
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog model ids must be unique'
          USING ERRCODE = '22023';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
        WHERE model ->> 'id' = p_value ->> 'default_model_id'
          AND model -> 'enabled' = 'true'::JSONB
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog default_model_id must identify an enabled model'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'llm_pricing_config' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_value -> 'balanceBaseline') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'fallbackCost') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'exchangeRate') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'markup') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'llm_pricing_config must include four numeric fields'
          USING ERRCODE = '22023';
      END IF;

      IF (p_value ->> 'balanceBaseline')::NUMERIC < 0
         OR (p_value ->> 'fallbackCost')::NUMERIC < 0
         OR (p_value ->> 'exchangeRate')::NUMERIC <= 0
         OR (p_value ->> 'markup')::NUMERIC <= 0 THEN
        RAISE EXCEPTION 'llm_pricing_config values are outside the allowed range'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'system_fallback_character_id' THEN
      IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'system_fallback_character_id must be a UUID JSON string'
          USING ERRCODE = '22023';
      END IF;

      BEGIN
        v_uuid := (p_value #>> '{}')::UUID;
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION 'system_fallback_character_id must be a UUID JSON string'
            USING ERRCODE = '22023';
      END;
  END CASE;

  -- text_value is retained as part of the runtime_config snapshot, but validation
  -- is deliberately based on the canonical JSON value consumed by these keys.
  PERFORM p_text_value;
END;
$$;

CREATE OR REPLACE FUNCTION admin.get_managed_configs()
RETURNS TABLE (
  key          TEXT,
  value        JSONB,
  description  TEXT,
  version      INTEGER,
  updated_at   TIMESTAMPTZ,
  text_value   TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor        admin.admin_users%ROWTYPE;
  v_environment TEXT;
BEGIN
  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT rc.*
  FROM miniapp.runtime_config AS rc
  WHERE admin.is_managed_config_key(rc.key)
  ORDER BY rc.key;
END;
$$;

CREATE OR REPLACE FUNCTION admin.save_config_draft(
  p_environment  TEXT,
  p_config_key   TEXT,
  p_value        JSONB,
  p_text_value   TEXT DEFAULT NULL,
  p_description  TEXT DEFAULT NULL
) RETURNS admin.config_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor         admin.admin_users%ROWTYPE;
  v_environment   TEXT;
  v_base_version  INTEGER;
  v_draft         admin.config_drafts%ROWTYPE;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('test', 'production') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment
      USING ERRCODE = '22023';
  END IF;

  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'viewer accounts are read-only'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  IF p_environment <> v_environment THEN
    RAISE EXCEPTION 'requested environment % does not match configured database environment %',
      p_environment, v_environment
      USING ERRCODE = '42501';
  END IF;

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(
    p_config_key,
    p_value,
    p_text_value
  );

  SELECT COALESCE(rc.version, 0)
  INTO v_base_version
  FROM miniapp.runtime_config AS rc
  WHERE rc.key = p_config_key;

  v_base_version := COALESCE(v_base_version, 0);

  INSERT INTO admin.config_drafts (
    environment,
    config_key,
    value,
    text_value,
    description,
    base_version,
    created_by,
    updated_by
  ) VALUES (
    v_environment,
    p_config_key,
    p_value,
    p_text_value,
    p_description,
    v_base_version,
    v_actor.user_id,
    v_actor.user_id
  )
  RETURNING * INTO v_draft;

  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value
  ) VALUES (
    v_actor.user_id,
    v_actor.email,
    v_environment,
    'config.draft.save',
    'admin',
    'config_drafts',
    v_draft.id::TEXT,
    NULL,
    to_jsonb(v_draft)
  );

  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION admin.publish_config_draft(
  p_draft_id UUID
) RETURNS admin.config_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor        admin.admin_users%ROWTYPE;
  v_environment  TEXT;
  v_draft        admin.config_drafts%ROWTYPE;
  v_runtime      miniapp.runtime_config%ROWTYPE;
  v_before       JSONB;
  v_release      admin.config_releases%ROWTYPE;
BEGIN
  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'viewer accounts are read-only'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  SELECT config_draft.*
  INTO v_draft
  FROM admin.config_drafts AS config_draft
  WHERE config_draft.id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'config draft not found: %', p_draft_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'draft' THEN
    RAISE EXCEPTION 'config draft has already been published: %', p_draft_id
      USING ERRCODE = '55000';
  END IF;

  IF v_draft.environment <> v_environment THEN
    RAISE EXCEPTION 'draft environment % does not match configured database environment %',
      v_draft.environment, v_environment
      USING ERRCODE = '42501';
  END IF;

  IF admin.is_managed_config_key(v_draft.config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config draft contains an invalid environment or config key'
      USING ERRCODE = '22023';
  END IF;

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(
    v_draft.config_key,
    v_draft.value,
    v_draft.text_value
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin.runtime_config:' || v_draft.config_key, 0)
  );

  SELECT to_jsonb(rc)
  INTO v_before
  FROM miniapp.runtime_config AS rc
  WHERE rc.key = v_draft.config_key
  FOR UPDATE;

  INSERT INTO miniapp.runtime_config AS rc (
    key,
    value,
    description,
    version,
    updated_at,
    text_value
  ) VALUES (
    v_draft.config_key,
    v_draft.value,
    v_draft.description,
    1,
    now(),
    v_draft.text_value
  )
  ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    version = COALESCE(rc.version, 0) + 1,
    updated_at = now(),
    text_value = EXCLUDED.text_value
  WHERE COALESCE(rc.version, 0) = v_draft.base_version
  RETURNING * INTO v_runtime;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'config changed after draft creation; save a new draft'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO admin.config_releases (
    environment,
    config_key,
    runtime_version,
    value,
    text_value,
    description,
    source_draft_id,
    released_by
  ) VALUES (
    v_environment,
    v_draft.config_key,
    v_runtime.version,
    v_runtime.value,
    v_runtime.text_value,
    v_runtime.description,
    v_draft.id,
    v_actor.user_id
  )
  RETURNING * INTO v_release;

  UPDATE admin.config_drafts
  SET
    status = 'published',
    updated_by = v_actor.user_id,
    updated_at = now(),
    published_at = now()
  WHERE id = v_draft.id;

  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value
  ) VALUES (
    v_actor.user_id,
    v_actor.email,
    v_environment,
    'config.publish',
    'miniapp',
    'runtime_config',
    v_draft.config_key,
    v_before,
    to_jsonb(v_runtime) || jsonb_build_object('release_id', v_release.id)
  );

  RETURN v_release;
END;
$$;

CREATE OR REPLACE FUNCTION admin.rollback_config_release(
  p_release_id UUID
) RETURNS admin.config_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor         admin.admin_users%ROWTYPE;
  v_environment   TEXT;
  v_target        admin.config_releases%ROWTYPE;
  v_runtime       miniapp.runtime_config%ROWTYPE;
  v_before        JSONB;
  v_new_release   admin.config_releases%ROWTYPE;
BEGIN
  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'viewer accounts are read-only'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  SELECT config_release.*
  INTO v_target
  FROM admin.config_releases AS config_release
  WHERE config_release.id = p_release_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'config release not found: %', p_release_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_target.environment <> v_environment THEN
    RAISE EXCEPTION 'release environment % does not match configured database environment %',
      v_target.environment, v_environment
      USING ERRCODE = '42501';
  END IF;

  IF admin.is_managed_config_key(v_target.config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config release contains an invalid environment or config key'
      USING ERRCODE = '22023';
  END IF;

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(
    v_target.config_key,
    v_target.value,
    v_target.text_value
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin.runtime_config:' || v_target.config_key, 0)
  );

  SELECT to_jsonb(rc)
  INTO v_before
  FROM miniapp.runtime_config AS rc
  WHERE rc.key = v_target.config_key
  FOR UPDATE;

  INSERT INTO miniapp.runtime_config AS rc (
    key,
    value,
    description,
    version,
    updated_at,
    text_value
  ) VALUES (
    v_target.config_key,
    v_target.value,
    v_target.description,
    1,
    now(),
    v_target.text_value
  )
  ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    version = COALESCE(rc.version, 0) + 1,
    updated_at = now(),
    text_value = EXCLUDED.text_value
  RETURNING * INTO v_runtime;

  INSERT INTO admin.config_releases (
    environment,
    config_key,
    runtime_version,
    value,
    text_value,
    description,
    rollback_of_release_id,
    released_by
  ) VALUES (
    v_environment,
    v_target.config_key,
    v_runtime.version,
    v_runtime.value,
    v_runtime.text_value,
    v_runtime.description,
    v_target.id,
    v_actor.user_id
  )
  RETURNING * INTO v_new_release;

  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value
  ) VALUES (
    v_actor.user_id,
    v_actor.email,
    v_environment,
    'config.rollback',
    'miniapp',
    'runtime_config',
    v_target.config_key,
    v_before,
    to_jsonb(v_runtime) || jsonb_build_object(
      'release_id', v_new_release.id,
      'rollback_of_release_id', v_target.id
    )
  );

  RETURN v_new_release;
END;
$$;

ALTER TABLE admin.environment_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.config_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.config_releases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_users_read_self ON admin.admin_users;
CREATE POLICY admin_users_read_self
  ON admin.admin_users
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND admin.is_registered_admin()
  );

DROP POLICY IF EXISTS audit_logs_read_permitted_environment ON admin.audit_logs;
CREATE POLICY audit_logs_read_permitted_environment
  ON admin.audit_logs
  FOR SELECT
  TO authenticated
  USING (admin.can_access_environment(environment));

DROP POLICY IF EXISTS config_drafts_read_permitted_environment ON admin.config_drafts;
CREATE POLICY config_drafts_read_permitted_environment
  ON admin.config_drafts
  FOR SELECT
  TO authenticated
  USING (admin.can_access_environment(environment));

DROP POLICY IF EXISTS config_releases_read_permitted_environment ON admin.config_releases;
CREATE POLICY config_releases_read_permitted_environment
  ON admin.config_releases
  FOR SELECT
  TO authenticated
  USING (admin.can_access_environment(environment));

REVOKE ALL ON SCHEMA admin FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA admin TO authenticated, service_role, postgres;

REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC, anon, authenticated;
GRANT SELECT ON admin.admin_users TO authenticated;
GRANT SELECT ON admin.audit_logs TO authenticated;
GRANT SELECT ON admin.config_drafts TO authenticated;
GRANT SELECT ON admin.config_releases TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA admin TO service_role, postgres;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.current_environment()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_registered_admin()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.can_access_environment(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.get_managed_configs()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.save_config_draft(TEXT, TEXT, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.publish_config_draft(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.rollback_config_release(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.is_registered_admin()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.can_access_environment(TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.current_environment()
  TO service_role;
GRANT EXECUTE ON FUNCTION admin.get_managed_configs()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.save_config_draft(TEXT, TEXT, JSONB, TEXT, TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.publish_config_draft(UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.rollback_config_release(UUID)
  TO authenticated, service_role;

COMMENT ON SCHEMA admin IS
  'Authenticated administration data, permissions, drafts, releases, and audit history.';

COMMENT ON TABLE admin.environment_config IS
  'Singleton database environment authority. Bootstrap id=1 as service_role/postgres after migration.';
COMMENT ON COLUMN admin.environment_config.environment IS
  'Authoritative database environment; authenticated callers cannot read or modify this table directly.';

COMMENT ON TABLE admin.admin_users IS
  'Allowlist of Supabase Auth users permitted to use the administration application.';
COMMENT ON COLUMN admin.admin_users.can_access_prod IS
  'Explicit production access flag; false by default for every role.';

COMMENT ON TABLE admin.audit_logs IS
  'Append-only audit snapshots written by admin mutation RPCs.';
COMMENT ON COLUMN admin.audit_logs.actor_email IS
  'Email snapshot resolved from admin.admin_users, never supplied by an RPC caller.';

COMMENT ON TABLE admin.config_drafts IS
  'Unpublished runtime_config snapshots with the source version used for optimistic locking.';
COMMENT ON COLUMN admin.config_drafts.base_version IS
  'runtime_config version observed when the draft was saved; publication fails if stale.';

COMMENT ON TABLE admin.config_releases IS
  'Immutable runtime_config release snapshots, including rollback-generated releases.';
COMMENT ON COLUMN admin.config_releases.runtime_version IS
  'Version written atomically to miniapp.runtime_config.';

COMMENT ON FUNCTION admin.current_environment() IS
  'Return the authoritative database environment, raising if the singleton has not been bootstrapped.';
COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Validate the canonical JSON value for a whitelisted managed config key.';
COMMENT ON FUNCTION admin.get_managed_configs() IS
  'Return current whitelisted runtime_config rows after admin and configured-environment authorization.';
COMMENT ON FUNCTION admin.save_config_draft(TEXT, TEXT, JSONB, TEXT, TEXT) IS
  'Save a whitelisted runtime-config draft after role and environment authorization.';
COMMENT ON FUNCTION admin.publish_config_draft(UUID) IS
  'Atomically publish a non-stale draft, increment runtime_config, snapshot the release, and audit it.';
COMMENT ON FUNCTION admin.rollback_config_release(UUID) IS
  'Restore a prior release as a new runtime_config version and release, with an audit snapshot.';

COMMIT;
