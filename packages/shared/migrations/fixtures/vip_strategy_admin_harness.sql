-- Local-only admin managed-config shape for the VIP strategy migration.
-- Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.config_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL,
  config_key TEXT NOT NULL,
  value JSONB,
  text_value TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_drafts_config_key_check CHECK (config_key IN ('system_instructions'))
);

CREATE TABLE IF NOT EXISTS admin.config_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL,
  config_key TEXT NOT NULL,
  value JSONB,
  text_value TEXT,
  runtime_version INTEGER NOT NULL DEFAULT 1,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_releases_config_key_check CHECK (config_key IN ('system_instructions'))
);

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key = 'system_instructions';
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
  IF p_config_key = 'system_instructions' THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'unmanaged config key %', p_config_key USING ERRCODE = '22023';
END;
$$;
