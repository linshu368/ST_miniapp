-- domain: experience
-- Backfill only rows whose immutable billing snapshot explicitly records the
-- OpenRouter caller. Existing raw generation JSON is deliberately not copied:
-- historical payloads have not been content-audited, while live writes use the
-- bounded Backend mapper. The parent business finish reason is not raw upstream
-- evidence and is therefore also left null in the provider-detail table.

BEGIN;

INSERT INTO experience.openrouter_chat_history (
  chat_history_id,
  llm_provider_name,
  llm_usage,
  llm_usage_cache,
  llm_native_tokens_cached,
  llm_native_tokens_reasoning,
  llm_native_tokens_completion,
  llm_native_tokens_prompt,
  llm_latency,
  llm_generation_time,
  llm_model,
  llm_generation_id,
  created_at,
  updated_at
)
SELECT
  history.id,
  'openrouter',
  history.llm_usage,
  history.llm_usage_cache,
  history.llm_native_tokens_cached,
  history.llm_native_tokens_reasoning,
  history.llm_native_tokens_completion,
  history.llm_native_tokens_prompt,
  history.llm_latency,
  history.llm_generation_time,
  history.llm_model,
  history.llm_generation_id,
  history.created_at,
  now()
FROM experience.chat_history AS history
WHERE history.llm_generation_id IS NOT NULL
  AND history.llm_billing_snapshot ->> 'provider' = 'openrouter'
ON CONFLICT (chat_history_id) DO UPDATE
SET
  llm_usage = COALESCE(experience.openrouter_chat_history.llm_usage, EXCLUDED.llm_usage),
  llm_usage_cache = COALESCE(
    experience.openrouter_chat_history.llm_usage_cache,
    EXCLUDED.llm_usage_cache
  ),
  llm_native_tokens_cached = COALESCE(
    experience.openrouter_chat_history.llm_native_tokens_cached,
    EXCLUDED.llm_native_tokens_cached
  ),
  llm_native_tokens_reasoning = COALESCE(
    experience.openrouter_chat_history.llm_native_tokens_reasoning,
    EXCLUDED.llm_native_tokens_reasoning
  ),
  llm_native_tokens_completion = COALESCE(
    experience.openrouter_chat_history.llm_native_tokens_completion,
    EXCLUDED.llm_native_tokens_completion
  ),
  llm_native_tokens_prompt = COALESCE(
    experience.openrouter_chat_history.llm_native_tokens_prompt,
    EXCLUDED.llm_native_tokens_prompt
  ),
  llm_latency = COALESCE(experience.openrouter_chat_history.llm_latency, EXCLUDED.llm_latency),
  llm_generation_time = COALESCE(
    experience.openrouter_chat_history.llm_generation_time,
    EXCLUDED.llm_generation_time
  ),
  llm_model = COALESCE(experience.openrouter_chat_history.llm_model, EXCLUDED.llm_model),
  llm_generation_id = COALESCE(
    experience.openrouter_chat_history.llm_generation_id,
    EXCLUDED.llm_generation_id
  ),
  updated_at = now();

COMMIT;

-- Forward-fix: this migration never changes parent chat_history fields and is
-- safe to reapply under the repository migration ledger's reviewed recovery path.
