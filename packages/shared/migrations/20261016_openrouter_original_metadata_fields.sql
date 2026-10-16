-- domain: experience
-- Expand before deploying the new OpenRouter writer. Legacy aliases stay only
-- for the running old Backend; the new Backend reads/writes provider field names.
-- llm_generation_id, llm_generation_data and parent business/billing columns stay unchanged.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.openrouter_chat_history
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS finish_reason text,
  ADD COLUMN IF NOT EXISTS usage jsonb,
  ADD COLUMN IF NOT EXISTS usage_cache jsonb,
  ADD COLUMN IF NOT EXISTS native_tokens_cached integer,
  ADD COLUMN IF NOT EXISTS native_tokens_reasoning integer,
  ADD COLUMN IF NOT EXISTS native_tokens_completion integer,
  ADD COLUMN IF NOT EXISTS native_tokens_prompt integer,
  ADD COLUMN IF NOT EXISTS latency numeric,
  ADD COLUMN IF NOT EXISTS generation_time numeric,
  ADD COLUMN IF NOT EXISTS model text;

DO $$
DECLARE
  field record;
BEGIN
  FOR field IN
    SELECT * FROM (VALUES
      ('provider_name', 'text'), ('finish_reason', 'text'),
      ('usage', 'jsonb'), ('usage_cache', 'jsonb'),
      ('native_tokens_cached', 'integer'), ('native_tokens_reasoning', 'integer'),
      ('native_tokens_completion', 'integer'), ('native_tokens_prompt', 'integer'),
      ('latency', 'numeric'), ('generation_time', 'numeric'), ('model', 'text')
    ) AS fields(name, expected_type)
  LOOP
    IF (
      SELECT count(*) FROM pg_attribute
      WHERE attrelid = 'experience.openrouter_chat_history'::regclass
        AND attname IN (field.name, 'llm_' || field.name)
        AND attnum > 0 AND NOT attisdropped
        AND format_type(atttypid, atttypmod) = field.expected_type
    ) <> 2 THEN
      RAISE EXCEPTION 'Unexpected OpenRouter metadata column shape: %', field.name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'experience.openrouter_chat_history'::regclass
      AND conname = 'openrouter_chat_history_original_fields_check'
  ) THEN
    ALTER TABLE experience.openrouter_chat_history
      ADD CONSTRAINT openrouter_chat_history_original_fields_check CHECK (
        (usage IS NULL OR jsonb_typeof(usage) = 'number')
        AND (usage_cache IS NULL OR jsonb_typeof(usage_cache) = 'number')
        AND (native_tokens_cached IS NULL OR native_tokens_cached >= 0)
        AND (native_tokens_reasoning IS NULL OR native_tokens_reasoning >= 0)
        AND (native_tokens_completion IS NULL OR native_tokens_completion >= 0)
        AND (native_tokens_prompt IS NULL OR native_tokens_prompt >= 0)
        AND (latency IS NULL OR latency >= 0)
        AND (generation_time IS NULL OR generation_time >= 0)
      );
  END IF;
END
$$;

-- Preserve zero values and any newer canonical writes on a reviewed rerun.
UPDATE experience.openrouter_chat_history
SET provider_name = COALESCE(provider_name, llm_provider_name),
    finish_reason = COALESCE(finish_reason, llm_finish_reason),
    usage = COALESCE(usage, llm_usage),
    usage_cache = COALESCE(usage_cache, llm_usage_cache),
    native_tokens_cached = COALESCE(native_tokens_cached, llm_native_tokens_cached),
    native_tokens_reasoning = COALESCE(native_tokens_reasoning, llm_native_tokens_reasoning),
    native_tokens_completion = COALESCE(native_tokens_completion, llm_native_tokens_completion),
    native_tokens_prompt = COALESCE(native_tokens_prompt, llm_native_tokens_prompt),
    latency = COALESCE(latency, llm_latency),
    generation_time = COALESCE(generation_time, llm_generation_time),
    model = COALESCE(model, llm_model)
WHERE (provider_name IS NULL AND llm_provider_name IS NOT NULL)
   OR (finish_reason IS NULL AND llm_finish_reason IS NOT NULL)
   OR (usage IS NULL AND llm_usage IS NOT NULL)
   OR (usage_cache IS NULL AND llm_usage_cache IS NOT NULL)
   OR (native_tokens_cached IS NULL AND llm_native_tokens_cached IS NOT NULL)
   OR (native_tokens_reasoning IS NULL AND llm_native_tokens_reasoning IS NOT NULL)
   OR (native_tokens_completion IS NULL AND llm_native_tokens_completion IS NOT NULL)
   OR (native_tokens_prompt IS NULL AND llm_native_tokens_prompt IS NOT NULL)
   OR (latency IS NULL AND llm_latency IS NOT NULL)
   OR (generation_time IS NULL AND llm_generation_time IS NOT NULL)
   OR (model IS NULL AND llm_model IS NOT NULL);

COMMENT ON COLUMN experience.openrouter_chat_history.provider_name IS
  'Original OpenRouter routing vendor field; the table identifies the OpenRouter caller.';
COMMENT ON COLUMN experience.openrouter_chat_history.finish_reason IS
  'Original upstream finish_reason; parent llm_finish_reason remains the business terminal state.';
COMMENT ON COLUMN experience.openrouter_chat_history.usage_cache IS
  'Optional original OpenRouter usage_cache value; absence does not mean zero.';

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Recovery: retain the expanded schema and use a forward-fix. Old Backend versions
-- can still use legacy aliases, but cannot see newer canonical values there.
-- Stop old writers and reconcile the cutover window before a separate contract
-- migration removes aliases. Do not rerun the earlier history-backfill files.
