-- Promote the four legacy llm_model_tiers entries into the formal model catalog.
-- Insert-only: a catalog already published by operations is never overwritten.

BEGIN;

DO $$
DECLARE
  v_legacy JSONB;
  v_catalog JSONB;
  v_required_model_ids TEXT[] := ARRAY[
    'google/gemini-3.1-flash-lite',
    'deepseek/deepseek-v3.2',
    'z-ai/glm-5.2',
    'google/gemini-3.1-pro-preview'
  ];
  v_present_model_ids TEXT[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM miniapp.runtime_config
    WHERE key = 'llm_model_catalog'
  ) THEN
    RETURN;
  END IF;

  SELECT value
  INTO v_legacy
  FROM miniapp.runtime_config
  WHERE key = 'llm_model_tiers';

  IF v_legacy IS NULL
     OR jsonb_typeof(v_legacy) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'llm_model_tiers is missing or invalid; cannot initialize llm_model_catalog'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT tier ->> 'modelName' ORDER BY tier ->> 'modelName')
  INTO v_present_model_ids
  FROM jsonb_array_elements(v_legacy) AS tier
  WHERE tier ->> 'modelName' = ANY(v_required_model_ids);

  IF COALESCE(cardinality(v_present_model_ids), 0) <> cardinality(v_required_model_ids) THEN
    RAISE EXCEPTION 'llm_model_tiers does not contain the expected four models: %',
      v_present_model_ids
      USING ERRCODE = '22023';
  END IF;

  v_catalog := '{
    "default_model_id": "gemini-flash-lite",
    "tiers": [
      {
        "tier": "light",
        "label": "轻量",
        "color": "#4ade80",
        "cost_hint": "快速日常对话",
        "sort_order": 0,
        "models": [
          {
            "id": "gemini-flash-lite",
            "openrouter_model_id": "google/gemini-3.1-flash-lite",
            "display_name": "Gemini Flash Lite",
            "tagline": "轻巧流畅",
            "price_input": 4.3,
            "price_output": 25.5,
            "enabled": true,
            "sort_order": 0
          }
        ]
      },
      {
        "tier": "standard",
        "label": "标准",
        "color": "#818cf8",
        "cost_hint": "兼顾质量与消耗",
        "sort_order": 1,
        "models": [
          {
            "id": "deepseek-v3.2",
            "openrouter_model_id": "deepseek/deepseek-v3.2",
            "display_name": "DeepSeek V3.2",
            "tagline": "推理均衡",
            "price_input": 4.6,
            "price_output": 6.8,
            "enabled": true,
            "sort_order": 0
          },
          {
            "id": "glm-5.2",
            "openrouter_model_id": "z-ai/glm-5.2",
            "display_name": "GLM 5.2",
            "tagline": "中文细腻",
            "price_input": 16.2,
            "price_output": 51.0,
            "enabled": true,
            "sort_order": 1
          }
        ]
      },
      {
        "tier": "premium",
        "label": "旗舰",
        "color": "#c084fc",
        "cost_hint": "复杂剧情与长文本",
        "sort_order": 2,
        "models": [
          {
            "id": "gemini-3.1-pro",
            "openrouter_model_id": "google/gemini-3.1-pro-preview",
            "display_name": "Gemini 3.1 Pro",
            "tagline": "旗舰沉浸",
            "price_input": 34.0,
            "price_output": 204.0,
            "enabled": true,
            "sort_order": 0
          }
        ]
      }
    ]
  }'::JSONB;

  PERFORM admin.validate_managed_config_value('llm_model_catalog', v_catalog, NULL);
  PERFORM admin.validate_model_catalog_prd(v_catalog);

  INSERT INTO miniapp.runtime_config (
    key,
    value,
    description,
    version,
    updated_at,
    text_value
  ) VALUES (
    'llm_model_catalog',
    v_catalog,
    '正式模型目录：稳定业务 ID、OpenRouter 映射、展示档位与展示价格。',
    1,
    now(),
    NULL
  );
END;
$$;

COMMIT;
