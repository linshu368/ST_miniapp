-- Allow the managed LLM catalog to route each stable model through OpenRouter or Venice.
-- Domain: admin. This evolves the existing runtime_config JSON contract and creates no new object.

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
    SELECT 1 FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE jsonb_typeof(tier) IS DISTINCT FROM 'object'
      OR COALESCE(tier ->> 'tier', '') NOT IN ('light', 'standard', 'premium')
      OR COALESCE(char_length(trim(tier ->> 'label')), 0) = 0
      OR COALESCE(char_length(trim(tier ->> 'color')), 0) = 0
      OR jsonb_typeof(tier -> 'sort_order') IS DISTINCT FROM 'number'
      OR jsonb_typeof(tier -> 'models') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains an invalid tier' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) <> count(DISTINCT tier ->> 'tier')
      FROM jsonb_array_elements(p_value -> 'tiers') AS tier) THEN
    RAISE EXCEPTION 'llm_model_catalog tier keys must be unique' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE jsonb_typeof(model) IS DISTINCT FROM 'object'
      OR COALESCE(char_length(trim(model ->> 'id')), 0) = 0
      OR COALESCE(model ->> 'provider', '') NOT IN ('openrouter', 'venice')
      OR COALESCE(char_length(trim(model ->> 'provider_model_id')), 0) = 0
      OR COALESCE(char_length(trim(model ->> 'openrouter_model_id')), 0) = 0
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) = 0
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) = 0
      OR jsonb_typeof(model -> 'enabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(model -> 'sort_order') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains an invalid model' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) <> count(DISTINCT model ->> 'id')
      FROM jsonb_array_elements(p_value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model) THEN
    RAISE EXCEPTION 'llm_model_catalog model ids must be unique' USING ERRCODE = '22023';
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
    SELECT 1 FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE trim(tier ->> 'label') = ''
      OR char_length(trim(tier ->> 'label')) > 20
      OR COALESCE(tier ->> 'color', '') !~ '^#[0-9A-Fa-f]{6}$'
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 50
      OR jsonb_array_length(tier -> 'models') = 0
      OR (tier ->> 'sort_order')::NUMERIC < 0
      OR (tier ->> 'sort_order')::NUMERIC <> trunc((tier ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD tier fields' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE COALESCE(model ->> 'id', '') !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
      OR char_length(model ->> 'id') > 64
      OR COALESCE(model ->> 'provider_model_id', '') !~ '^[^[:space:]]+$'
      OR char_length(model ->> 'provider_model_id') > 200
      OR model ->> 'openrouter_model_id' <> model ->> 'provider_model_id'
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) NOT BETWEEN 1 AND 40
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 40
      OR jsonb_typeof(model -> 'markup') IS DISTINCT FROM 'number'
      OR (model ->> 'markup')::NUMERIC NOT IN (0, 1, 1.5, 2, 2.5, 3, 3.5, 4)
      OR ((model ->> 'markup')::NUMERIC = 0 AND (
        jsonb_typeof(model -> 'deduct_markup') IS DISTINCT FROM 'number'
        OR (model ->> 'deduct_markup')::NUMERIC NOT IN (1, 1.5, 2, 2.5, 3, 3.5, 4)))
      OR ((model ->> 'markup')::NUMERIC <> 0 AND model ? 'deduct_markup')
      OR (model ->> 'sort_order')::NUMERIC < 0
      OR (model ->> 'sort_order')::NUMERIC <> trunc((model ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD model fields' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) <> count(DISTINCT concat(model ->> 'provider', E'\x1f', model ->> 'provider_model_id'))
      FROM jsonb_array_elements(p_value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model) THEN
    RAISE EXCEPTION 'llm_model_catalog provider mappings must be unique' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Existing rows are OpenRouter rows. Backfill all three managed surfaces before validation is tightened.
UPDATE app_core.runtime_config
SET value = jsonb_set(
  value,
  '{tiers}',
  (SELECT jsonb_agg(jsonb_set(tier, '{models}', (
    SELECT jsonb_agg(model || jsonb_build_object(
      'provider', 'openrouter',
      'provider_model_id', model ->> 'openrouter_model_id'))
    FROM jsonb_array_elements(tier -> 'models') AS model
  ))) FROM jsonb_array_elements(value -> 'tiers') AS tier)
)
WHERE key = 'llm_model_catalog';

UPDATE admin.config_drafts
SET value = jsonb_set(
  value,
  '{tiers}',
  (SELECT jsonb_agg(jsonb_set(tier, '{models}', (
    SELECT jsonb_agg(model || jsonb_build_object(
      'provider', 'openrouter',
      'provider_model_id', model ->> 'openrouter_model_id'))
    FROM jsonb_array_elements(tier -> 'models') AS model
  ))) FROM jsonb_array_elements(value -> 'tiers') AS tier)
)
WHERE config_key = 'llm_model_catalog' AND value IS NOT NULL;

UPDATE admin.config_releases
SET value = jsonb_set(
  value,
  '{tiers}',
  (SELECT jsonb_agg(jsonb_set(tier, '{models}', (
    SELECT jsonb_agg(model || jsonb_build_object(
      'provider', 'openrouter',
      'provider_model_id', model ->> 'openrouter_model_id'))
    FROM jsonb_array_elements(tier -> 'models') AS model
  ))) FROM jsonb_array_elements(value -> 'tiers') AS tier)
)
WHERE config_key = 'llm_model_catalog' AND value IS NOT NULL;

DO $$
DECLARE v_value JSONB;
BEGIN
  FOR v_value IN
    SELECT value FROM app_core.runtime_config WHERE key = 'llm_model_catalog'
    UNION ALL SELECT value FROM admin.config_drafts
      WHERE config_key = 'llm_model_catalog' AND value IS NOT NULL
    UNION ALL SELECT value FROM admin.config_releases
      WHERE config_key = 'llm_model_catalog' AND value IS NOT NULL
  LOOP
    PERFORM admin.validate_model_catalog_core(v_value);
    PERFORM admin.validate_model_catalog_prd(v_value);
  END LOOP;
END;
$$;

COMMIT;
