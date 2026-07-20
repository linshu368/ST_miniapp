-- Complete model selector support:
-- 1. Persist the user's stable catalog model selection.
-- 2. Reuse one active admin draft per environment/config key for auto-save.

BEGIN;

ALTER TABLE miniapp.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS selected_model_id TEXT;

COMMENT ON COLUMN miniapp.miniapp_user_settings.selected_model_id IS
  'Stable llm_model_catalog model id selected by the user; never stores a provider model slug.';

-- Older UI revisions created a new draft on every save. Keep only the latest
-- active row before enforcing one reusable draft per environment/config key.
DELETE FROM admin.config_drafts AS older
USING admin.config_drafts AS newer
WHERE older.status = 'draft'
  AND newer.status = 'draft'
  AND older.environment = newer.environment
  AND older.config_key = newer.config_key
  AND (
    older.updated_at < newer.updated_at
    OR (older.updated_at = newer.updated_at AND older.id::TEXT < newer.id::TEXT)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_config_drafts_one_active
  ON admin.config_drafts (environment, config_key)
  WHERE status = 'draft';

CREATE OR REPLACE FUNCTION admin.validate_model_catalog_prd(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE trim(tier ->> 'label') = ''
      OR char_length(trim(tier ->> 'label')) > 20
      OR COALESCE(tier ->> 'color', '') !~ '^#[0-9A-Fa-f]{6}$'
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 30
      OR jsonb_array_length(tier -> 'models') = 0
      OR (tier ->> 'sort_order')::NUMERIC < 0
      OR (tier ->> 'sort_order')::NUMERIC <> trunc((tier ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD tier fields'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE COALESCE(model ->> 'id', '') !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
      OR char_length(model ->> 'id') > 64
      OR COALESCE(model ->> 'openrouter_model_id', '') !~ '^[^[:space:]/]+/[^[:space:]/]+$'
      OR char_length(model ->> 'openrouter_model_id') > 200
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) NOT BETWEEN 1 AND 40
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 15
      OR (model ->> 'price_input')::NUMERIC * 10
         <> trunc((model ->> 'price_input')::NUMERIC * 10)
      OR (model ->> 'price_output')::NUMERIC * 10
         <> trunc((model ->> 'price_output')::NUMERIC * 10)
      OR (model ->> 'sort_order')::NUMERIC < 0
      OR (model ->> 'sort_order')::NUMERIC <> trunc((model ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD model fields'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT model ->> 'openrouter_model_id')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog OpenRouter mappings must be unique'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_model_catalog_draft_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.config_key = 'llm_model_catalog' THEN
    PERFORM admin.validate_model_catalog_prd(NEW.value);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_drafts_validate_model_catalog_prd ON admin.config_drafts;
CREATE TRIGGER config_drafts_validate_model_catalog_prd
  BEFORE INSERT OR UPDATE OF value ON admin.config_drafts
  FOR EACH ROW
  EXECUTE FUNCTION admin.validate_model_catalog_draft_trigger();

CREATE OR REPLACE FUNCTION admin.upsert_config_draft(
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
  v_actor   admin.admin_users%ROWTYPE;
  v_before  JSONB;
  v_draft   admin.config_drafts%ROWTYPE;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF p_environment <> admin.current_environment()
     OR (p_environment = 'test' AND NOT v_actor.can_access_test)
     OR (p_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access requested environment'
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(p_config_key, p_value, p_text_value);

  SELECT draft.*
  INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.environment = p_environment
    AND draft.config_key = p_config_key
    AND draft.status = 'draft'
  FOR UPDATE;

  IF FOUND THEN
    v_before := to_jsonb(v_draft);
    UPDATE admin.config_drafts
    SET value = p_value,
        text_value = p_text_value,
        description = p_description,
        updated_by = v_actor.user_id,
        updated_at = now()
    WHERE id = v_draft.id
    RETURNING * INTO v_draft;

    INSERT INTO admin.audit_logs (
      actor_user_id, actor_email, environment, action, schema_name,
      table_name, record_id, before_value, after_value
    ) VALUES (
      v_actor.user_id, v_actor.email, p_environment, 'config.draft.autosave',
      'admin', 'config_drafts', v_draft.id::TEXT, v_before, to_jsonb(v_draft)
    );
    RETURN v_draft;
  END IF;

  RETURN admin.save_config_draft(
    p_environment,
    p_config_key,
    p_value,
    p_text_value,
    p_description
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.upsert_config_draft(TEXT, TEXT, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.upsert_config_draft(TEXT, TEXT, JSONB, TEXT, TEXT)
  TO authenticated, service_role, postgres;

COMMIT;
