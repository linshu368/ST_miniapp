-- Migration 032_llm_dynamic_pricing.sql
-- Description: Insert the configuration for LLM dynamic pricing into runtime_config

INSERT INTO miniapp.runtime_config (key, value, description)
VALUES (
    'llm_pricing_config',
    '{"balanceBaseline": 30, "fallbackCost": 30, "exchangeRate": 680, "markup": 2.5}'::jsonb,
    'LLM动态扣费配置: balanceBaseline(余额预检基线), fallbackCost(获取usage失败时的兜底额), exchangeRate(汇率), markup(加价倍率)'
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description;
