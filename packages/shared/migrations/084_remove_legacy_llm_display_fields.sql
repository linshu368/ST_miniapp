-- Remove obsolete display-price and dynamic-billing fields from managed LLM configs.

BEGIN;

CREATE OR REPLACE FUNCTION admin.validate_model_catalog_core(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
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
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) = 0
      OR jsonb_typeof(model -> 'enabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(model -> 'sort_order') IS DISTINCT FROM 'number'
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
END;
$$;

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
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 50
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
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 40
      OR jsonb_typeof(model -> 'markup') IS DISTINCT FROM 'number'
      OR (model ->> 'markup')::NUMERIC NOT IN (0, 1, 1.5, 2, 2.5, 3, 3.5, 4)
      OR (
        (model ->> 'markup')::NUMERIC = 0
        AND (
          jsonb_typeof(model -> 'deduct_markup') IS DISTINCT FROM 'number'
          OR (model ->> 'deduct_markup')::NUMERIC NOT IN (1, 1.5, 2, 2.5, 3, 3.5, 4)
        )
      )
      OR (
        (model ->> 'markup')::NUMERIC <> 0
        AND model ? 'deduct_markup'
      )
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
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}}, {{INTERACTION_MODE}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'pref_word_count_tiers' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'pref_word_count_tiers must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_value -> 'tiers') = 0
       OR jsonb_typeof(p_value -> 'default_tier_id') IS DISTINCT FROM 'string'
       OR COALESCE(char_length(trim(p_value ->> 'default_tier_id')), 0) = 0 THEN
      RAISE EXCEPTION
        'pref_word_count_tiers must include nonempty tiers and default_tier_id'
        USING ERRCODE = '22023';
    END IF;

    v_columns := NULLIF(p_value #>> '{layout,columns}', '')::NUMERIC;
    IF v_columns IS NULL OR v_columns NOT IN (2, 3, 4) THEN
      RAISE EXCEPTION 'pref_word_count_tiers.layout.columns must be 2, 3 or 4'
        USING ERRCODE = '22023';
    END IF;

    v_ids := ARRAY[]::TEXT[];
    v_default := trim(p_value ->> 'default_tier_id');
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_value -> 'tiers')
    LOOP
      IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
         OR COALESCE(char_length(trim(v_tier ->> 'id')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'ui_label')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'prompt_value')), 0) = 0
         OR jsonb_typeof(v_tier -> 'enabled') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(v_tier -> 'sort_order') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'pref_word_count_tiers contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF trim(v_tier ->> 'id') = ANY (v_ids) THEN
        RAISE EXCEPTION 'pref_word_count_tiers tier ids must be unique'
          USING ERRCODE = '22023';
      END IF;
      v_ids := array_append(v_ids, trim(v_tier ->> 'id'));

      IF trim(v_tier ->> 'id') = v_default AND (v_tier ->> 'enabled')::BOOLEAN IS TRUE THEN
        v_enabled_default := TRUE;
      END IF;
    END LOOP;

    IF NOT v_enabled_default THEN
      RAISE EXCEPTION 'pref_word_count_tiers.default_tier_id must match an enabled tier'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_character_free_chat_quota_limit' THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION
        'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
        USING ERRCODE = '22023';
    END IF;
    PERFORM p_text_value;
    RETURN;
  END IF;

  IF p_config_key = 'llm_model_catalog' THEN
    PERFORM admin.validate_model_catalog_core(p_value);
    PERFORM admin.validate_model_catalog_prd(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'llm_pricing_config' THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_value -> 'exchangeRate') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_value -> 'markup') IS DISTINCT FROM 'number'
       OR (p_value ->> 'exchangeRate')::NUMERIC <= 0
       OR (p_value ->> 'markup')::NUMERIC <= 0 THEN
      RAISE EXCEPTION 'llm_pricing_config must include positive exchangeRate and markup'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_fixed_llm_deduction_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_fixed_billing(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

WITH rewritten AS (
  SELECT
    rc.key,
    jsonb_set(
      rc.value,
      '{tiers}',
      (
        SELECT jsonb_agg(
          (tier - 'models') || jsonb_build_object(
            'models',
            (
              SELECT jsonb_agg(model - 'price_input' - 'price_output' ORDER BY model_ordinality)
              FROM jsonb_array_elements(tier -> 'models')
                WITH ORDINALITY AS models(model, model_ordinality)
            )
          )
          ORDER BY tier_ordinality
        )
        FROM jsonb_array_elements(rc.value -> 'tiers')
          WITH ORDINALITY AS tiers(tier, tier_ordinality)
      ),
      false
    ) AS value
  FROM miniapp.runtime_config AS rc
  WHERE rc.key = 'llm_model_catalog'
)
UPDATE miniapp.runtime_config AS rc
SET
  value = rewritten.value,
  description = '用户可选择的 OpenRouter 模型、档位与默认模型。',
  version = COALESCE(rc.version, 0) + 1,
  updated_at = now()
FROM rewritten
WHERE rc.key = rewritten.key;

UPDATE miniapp.runtime_config
SET
  value = value - 'balanceBaseline' - 'fallbackCost',
  description = 'LLM 固定扣费参数与保留的历史兼容参数。',
  version = COALESCE(version, 0) + 1,
  updated_at = now()
WHERE key = 'llm_pricing_config';

-- Drafts may intentionally contain incomplete model cards while an operator is
-- editing. Rewriting those JSON values would otherwise re-run the strict PRD
-- trigger and reject an unrelated legacy draft.
ALTER TABLE admin.config_drafts
  DISABLE TRIGGER config_drafts_validate_model_catalog_prd;

WITH rewritten AS (
  SELECT
    draft.id,
    jsonb_set(
      draft.value,
      '{tiers}',
      (
        SELECT jsonb_agg(
          (tier - 'models') || jsonb_build_object(
            'models',
            (
              SELECT jsonb_agg(model - 'price_input' - 'price_output' ORDER BY model_ordinality)
              FROM jsonb_array_elements(tier -> 'models')
                WITH ORDINALITY AS models(model, model_ordinality)
            )
          )
          ORDER BY tier_ordinality
        )
        FROM jsonb_array_elements(draft.value -> 'tiers')
          WITH ORDINALITY AS tiers(tier, tier_ordinality)
      ),
      false
    ) AS value
  FROM admin.config_drafts AS draft
  WHERE draft.config_key = 'llm_model_catalog'
    AND jsonb_typeof(draft.value -> 'tiers') = 'array'
)
UPDATE admin.config_drafts AS draft
SET value = rewritten.value
FROM rewritten
WHERE draft.id = rewritten.id;

UPDATE admin.config_drafts
SET value = value - 'balanceBaseline' - 'fallbackCost'
WHERE config_key = 'llm_pricing_config'
  AND jsonb_typeof(value) = 'object';

ALTER TABLE admin.config_drafts
  ENABLE TRIGGER config_drafts_validate_model_catalog_prd;

WITH rewritten AS (
  SELECT
    release.id,
    jsonb_set(
      release.value,
      '{tiers}',
      (
        SELECT jsonb_agg(
          (tier - 'models') || jsonb_build_object(
            'models',
            (
              SELECT jsonb_agg(model - 'price_input' - 'price_output' ORDER BY model_ordinality)
              FROM jsonb_array_elements(tier -> 'models')
                WITH ORDINALITY AS models(model, model_ordinality)
            )
          )
          ORDER BY tier_ordinality
        )
        FROM jsonb_array_elements(release.value -> 'tiers')
          WITH ORDINALITY AS tiers(tier, tier_ordinality)
      ),
      false
    ) AS value
  FROM admin.config_releases AS release
  WHERE release.config_key = 'llm_model_catalog'
    AND jsonb_typeof(release.value -> 'tiers') = 'array'
)
UPDATE admin.config_releases AS release
SET value = rewritten.value
FROM rewritten
WHERE release.id = rewritten.id;

UPDATE admin.config_releases
SET value = value - 'balanceBaseline' - 'fallbackCost'
WHERE config_key = 'llm_pricing_config'
  AND jsonb_typeof(value) = 'object';

REVOKE ALL ON FUNCTION admin.validate_model_catalog_core(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_model_catalog_prd(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
