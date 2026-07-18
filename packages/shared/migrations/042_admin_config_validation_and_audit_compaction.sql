-- Fix recharge config dispatch and keep character-reorder audits compact.

BEGIN;

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
     OR COALESCE(p_value ->> 'theme_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'balance_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'selected_plan_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'badge_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'button_color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'miniapp_recharge_page_config is invalid'
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

    WHEN p_config_key = 'miniapp_recharge_page_config' THEN
      PERFORM admin.validate_recharge_page_config(p_value);

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

    ELSE
      RAISE EXCEPTION 'managed config validation is missing for key: %', p_config_key
        USING ERRCODE = '22023';
  END CASE;

  PERFORM p_text_value;
END;
$$;

UPDATE miniapp.runtime_config
SET value = jsonb_build_object(
      'balance_color', '#8b5cf6',
      'selected_plan_color', '#f59e0b',
      'badge_color', '#6366f1',
      'button_color', '#ec4899'
    ) || value,
    version = COALESCE(version, 0) + 1,
    updated_at = now()
WHERE key = 'miniapp_recharge_page_config'
  AND (
    NOT value ? 'balance_color'
    OR NOT value ? 'selected_plan_color'
    OR NOT value ? 'badge_color'
    OR NOT value ? 'button_color'
  );

UPDATE admin.config_drafts
SET value = jsonb_build_object(
      'balance_color', '#8b5cf6',
      'selected_plan_color', '#f59e0b',
      'badge_color', '#6366f1',
      'button_color', '#ec4899'
    ) || value,
    updated_at = now()
WHERE config_key = 'miniapp_recharge_page_config'
  AND status = 'draft'
  AND (
    NOT value ? 'balance_color'
    OR NOT value ? 'selected_plan_color'
    OR NOT value ? 'badge_color'
    OR NOT value ? 'button_color'
  );

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

  SELECT jsonb_agg(
    jsonb_build_object('id', card.id, 'sort_order', card.sort_order)
    ORDER BY card.sort_order, card.id
  )
  INTO v_before
  FROM miniapp.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  UPDATE miniapp.characters AS card
  SET sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  FROM unnest(p_character_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  SELECT jsonb_agg(
    jsonb_build_object('id', card.id, 'sort_order', card.sort_order)
    ORDER BY card.sort_order, card.id
  )
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

UPDATE admin.audit_logs AS audit
SET before_value = (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', item ->> 'id',
          'sort_order', (item ->> 'sort_order')::INTEGER
        )
      )
      FROM jsonb_array_elements(audit.before_value) AS item
    ),
    after_value = (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', item ->> 'id',
          'sort_order', (item ->> 'sort_order')::INTEGER
        )
      )
      FROM jsonb_array_elements(audit.after_value) AS item
    )
WHERE action = 'character.reorder'
  AND jsonb_typeof(before_value) = 'array'
  AND jsonb_typeof(after_value) = 'array'
  AND pg_column_size(before_value) + pg_column_size(after_value) > 1048576;

COMMIT;
