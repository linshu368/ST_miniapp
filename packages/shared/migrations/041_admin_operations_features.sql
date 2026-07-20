-- Per-model markup, recharge-page configuration, and writable character management.

BEGIN;

ALTER TABLE miniapp.characters
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS idx_characters_active_order
  ON miniapp.characters (enabled, sort_order, created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
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
    'miniapp_recharge_page_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  ));

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
    'miniapp_recharge_page_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id'
  );
$$;

INSERT INTO miniapp.runtime_config (
  key, value, description, version, updated_at, text_value
) VALUES (
  'miniapp_recharge_page_config',
  '{
    "title": "星尘商店",
    "description": "为每段相遇点一盏星光",
    "button_text": "立即支付",
    "theme_color": "#ec4899"
  }'::JSONB,
  '充值页面标题、说明、支付按钮文案和主题色。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_markup NUMERIC;
BEGIN
  SELECT CASE
    WHEN (value ->> 'markup')::NUMERIC IN (1, 1.5, 2, 2.5, 3, 3.5, 4)
      THEN (value ->> 'markup')::NUMERIC
    ELSE 2.5
  END
  INTO v_markup
  FROM miniapp.runtime_config
  WHERE key = 'llm_pricing_config';

  v_markup := COALESCE(v_markup, 2.5);

  UPDATE miniapp.runtime_config AS config
  SET value = jsonb_set(
        config.value,
        '{tiers}',
        (
          SELECT jsonb_agg(
            jsonb_set(
              tier,
              '{models}',
              (
                SELECT jsonb_agg(
                  CASE
                    WHEN model ? 'markup' THEN model
                    ELSE model || jsonb_build_object('markup', v_markup)
                  END
                  ORDER BY model_index
                )
                FROM jsonb_array_elements(tier -> 'models')
                  WITH ORDINALITY AS models(model, model_index)
              )
            )
            ORDER BY tier_index
          )
          FROM jsonb_array_elements(config.value -> 'tiers')
            WITH ORDINALITY AS tiers(tier, tier_index)
        )
      ),
      version = COALESCE(config.version, 0) + 1,
      updated_at = now()
  WHERE config.key = 'llm_model_catalog'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(config.value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      WHERE NOT model ? 'markup'
    );

  UPDATE admin.config_drafts AS draft
  SET value = jsonb_set(
        draft.value,
        '{tiers}',
        (
          SELECT jsonb_agg(
            jsonb_set(
              tier,
              '{models}',
              (
                SELECT jsonb_agg(
                  CASE
                    WHEN model ? 'markup' THEN model
                    ELSE model || jsonb_build_object('markup', v_markup)
                  END
                  ORDER BY model_index
                )
                FROM jsonb_array_elements(tier -> 'models')
                  WITH ORDINALITY AS models(model, model_index)
              )
            )
            ORDER BY tier_index
          )
          FROM jsonb_array_elements(draft.value -> 'tiers')
            WITH ORDINALITY AS tiers(tier, tier_index)
        )
      ),
      updated_at = now()
  WHERE draft.config_key = 'llm_model_catalog'
    AND draft.status = 'draft'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(draft.value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      WHERE NOT model ? 'markup'
    );
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_recharge_page_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR COALESCE(char_length(trim(p_value ->> 'title')), 0) NOT BETWEEN 1 AND 30
     OR COALESCE(char_length(trim(p_value ->> 'description')), 0) NOT BETWEEN 1 AND 120
     OR COALESCE(char_length(trim(p_value ->> 'button_text')), 0) NOT BETWEEN 1 AND 20
     OR COALESCE(p_value ->> 'theme_color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'miniapp_recharge_page_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_operations_config_draft_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.config_key = 'miniapp_recharge_page_config' THEN
    PERFORM admin.validate_recharge_page_config(NEW.value);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_drafts_validate_operations_config ON admin.config_drafts;
CREATE TRIGGER config_drafts_validate_operations_config
  BEFORE INSERT OR UPDATE OF value ON admin.config_drafts
  FOR EACH ROW
  EXECUTE FUNCTION admin.validate_operations_config_draft_trigger();

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
      OR jsonb_typeof(model -> 'markup') IS DISTINCT FROM 'number'
      OR (model ->> 'markup')::NUMERIC NOT IN (1, 1.5, 2, 2.5, 3, 3.5, 4)
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

CREATE OR REPLACE FUNCTION admin.get_characters()
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  tags JSONB,
  creator TEXT,
  first_mes TEXT,
  creator_notes TEXT,
  enabled BOOLEAN,
  sort_order INTEGER,
  created_at TIMESTAMP WITHOUT TIME ZONE,
  updated_at TIMESTAMP WITHOUT TIME ZONE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    card.id, card.name, card.description, card.avatar_url, card.tags,
    card.creator, card.first_mes, card.creator_notes, card.enabled,
    card.sort_order, card.created_at, card.updated_at
  FROM miniapp.characters AS card
  WHERE card.archived_at IS NULL
  ORDER BY card.enabled DESC, card.sort_order ASC, card.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin.set_character_enabled(
  p_character_id UUID,
  p_enabled BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.characters%ROWTYPE;
  v_after miniapp.characters%ROWTYPE;
  v_next_order INTEGER;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT card.* INTO v_before
  FROM miniapp.characters AS card
  WHERE card.id = p_character_id AND card.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active character not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_enabled AND NOT v_before.enabled THEN
    SELECT COALESCE(max(card.sort_order), -1) + 1 INTO v_next_order
    FROM miniapp.characters AS card
    WHERE card.enabled AND card.archived_at IS NULL;
  ELSE
    v_next_order := v_before.sort_order;
  END IF;

  UPDATE miniapp.characters
  SET enabled = p_enabled,
      sort_order = v_next_order,
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  WHERE id = p_character_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN p_enabled THEN 'character.enable' ELSE 'character.disable' END,
    'miniapp', 'characters', p_character_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION admin.reorder_characters(p_character_ids UUID[])
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_expected INTEGER;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_expected
  FROM miniapp.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  IF cardinality(p_character_ids) <> v_expected
     OR (
       SELECT count(DISTINCT item.id)
       FROM unnest(p_character_ids) AS item(id)
     ) <> v_expected
     OR EXISTS (
       SELECT 1 FROM unnest(p_character_ids) AS item(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM miniapp.characters AS card
         WHERE card.id = item.id AND card.enabled AND card.archived_at IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'reorder must include every enabled active character exactly once'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_agg(to_jsonb(card) ORDER BY card.sort_order, card.id)
  INTO v_before
  FROM miniapp.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  UPDATE miniapp.characters AS card
  SET sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  FROM unnest(p_character_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  SELECT jsonb_agg(to_jsonb(card) ORDER BY card.sort_order, card.id)
  INTO v_after
  FROM miniapp.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'character.reorder', 'miniapp', 'characters', 'enabled',
    v_before, v_after
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION admin.archive_character(p_character_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.characters%ROWTYPE;
  v_after miniapp.characters%ROWTYPE;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT card.* INTO v_before
  FROM miniapp.characters AS card
  WHERE card.id = p_character_id AND card.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active character not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp.characters
  SET enabled = false,
      archived_at = timezone('Asia/Shanghai'::TEXT, now()),
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  WHERE id = p_character_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'character.archive', 'miniapp', 'characters', p_character_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_recharge_page_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_operations_config_draft_trigger()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.set_character_enabled(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.reorder_characters(UUID[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.archive_character(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.set_character_enabled(UUID, BOOLEAN)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.reorder_characters(UUID[])
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.archive_character(UUID)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_characters()
  TO authenticated, service_role, postgres;

COMMIT;
