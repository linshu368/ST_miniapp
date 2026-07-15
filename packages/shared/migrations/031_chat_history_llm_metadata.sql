-- Migration 031: Add OpenRouter LLM metadata fields to chat_history
-- 存储 OpenRouter API 调用的详细指标和元数据

ALTER TABLE miniapp.chat_history
  ADD COLUMN IF NOT EXISTS llm_provider_name text,
  ADD COLUMN IF NOT EXISTS llm_finish_reason text,
  ADD COLUMN IF NOT EXISTS llm_usage jsonb,
  ADD COLUMN IF NOT EXISTS llm_usage_cache jsonb,
  ADD COLUMN IF NOT EXISTS llm_native_tokens_cached integer,
  ADD COLUMN IF NOT EXISTS llm_native_tokens_reasoning integer,
  ADD COLUMN IF NOT EXISTS llm_native_tokens_completion integer,
  ADD COLUMN IF NOT EXISTS llm_native_tokens_prompt integer,
  ADD COLUMN IF NOT EXISTS llm_latency numeric,
  ADD COLUMN IF NOT EXISTS llm_generation_time numeric,
  ADD COLUMN IF NOT EXISTS llm_model text,
  ADD COLUMN IF NOT EXISTS llm_generation_id text,
  ADD COLUMN IF NOT EXISTS llm_generation_data jsonb;

COMMENT ON COLUMN miniapp.chat_history.llm_provider_name IS 'OpenRouter实际路由的底层厂商名称';
COMMENT ON COLUMN miniapp.chat_history.llm_finish_reason IS '流结束原因';
COMMENT ON COLUMN miniapp.chat_history.llm_usage IS 'Token使用量统计';
COMMENT ON COLUMN miniapp.chat_history.llm_usage_cache IS '缓存Token使用量统计';
COMMENT ON COLUMN miniapp.chat_history.llm_native_tokens_cached IS '原生缓存Token数';
COMMENT ON COLUMN miniapp.chat_history.llm_native_tokens_reasoning IS '原生推理Token数';
COMMENT ON COLUMN miniapp.chat_history.llm_native_tokens_completion IS '原生补全Token数';
COMMENT ON COLUMN miniapp.chat_history.llm_native_tokens_prompt IS '原生提示词Token数';
COMMENT ON COLUMN miniapp.chat_history.llm_latency IS '首字延迟(ms)';
COMMENT ON COLUMN miniapp.chat_history.llm_generation_time IS '生成总耗时(ms)';
COMMENT ON COLUMN miniapp.chat_history.llm_model IS 'OpenRouter实际使用的模型名';
COMMENT ON COLUMN miniapp.chat_history.llm_generation_id IS 'OpenRouter Generation ID';
COMMENT ON COLUMN miniapp.chat_history.llm_generation_data IS 'OpenRouter Generation 完整原始数据';
