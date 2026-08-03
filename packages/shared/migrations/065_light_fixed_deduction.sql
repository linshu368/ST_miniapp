-- Add light-tier fixed per-round deduction to llm_pricing_config.

BEGIN;

UPDATE miniapp.runtime_config
SET
  value = jsonb_set(
    COALESCE(value, '{}'::JSONB),
    '{fixedDeduction}',
    COALESCE(value -> 'fixedDeduction', '{}'::JSONB)
      || jsonb_build_object(
        'light',
        COALESCE((value #>> '{fixedDeduction,light}')::NUMERIC, 15)
      ),
    true
  ),
  description = 'LLM 固定扣费：免费模型额度用尽后、轻量档、标准档、旗舰档各自固定星尘/轮。',
  version = COALESCE(version, 0) + 1,
  updated_at = now()
WHERE key = 'llm_pricing_config';

CREATE OR REPLACE FUNCTION admin.validate_fixed_llm_deduction_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'fixedDeduction') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'freeQuotaExhausted')
        IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'light') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'standard') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'premium') IS DISTINCT FROM 'number'
     OR (p_value #>> '{fixedDeduction,freeQuotaExhausted}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,light}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,standard}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,premium}')::NUMERIC < 0 THEN
    RAISE EXCEPTION
      'llm_pricing_config.fixedDeduction must include nonnegative freeQuotaExhausted, light, standard and premium amounts'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.validate_fixed_llm_deduction_config(JSONB) IS
  'Validate fixed per-round LLM deduction amounts in llm_pricing_config.';

COMMIT;
