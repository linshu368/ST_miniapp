-- domain: experience
-- T3 TEST forward-fix: the caller is OpenRouter when a generation ID exists and
-- the parent has no Venice detail row. llm_provider_name is OpenRouter's routed
-- vendor, not a caller discriminator. Historical raw JSON and the parent's
-- business finish reason are deliberately excluded.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Stop rather than silently mixing providers if the exclusion invariant has
-- been violated by an incomplete Venice write or a conflicting billing fact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM experience.chat_history AS history
    LEFT JOIN experience.venice_chat_history AS venice
      ON venice.chat_history_id = history.id
    WHERE history.llm_generation_id IS NOT NULL
      AND venice.chat_history_id IS NULL
      AND history.llm_billing_snapshot ->> 'provider' = 'venice'
  ) THEN
    RAISE EXCEPTION 'Venice billing snapshot without Venice detail row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM experience.openrouter_chat_history AS router
    JOIN experience.venice_chat_history AS venice
      ON venice.chat_history_id = router.chat_history_id
  ) THEN
    RAISE EXCEPTION 'OpenRouter and Venice detail rows overlap';
  END IF;
END
$$;

ALTER TABLE experience.openrouter_chat_history
  DROP CONSTRAINT openrouter_chat_history_provider_check;
ALTER TABLE experience.openrouter_chat_history
  ALTER COLUMN llm_provider_name DROP NOT NULL,
  ALTER COLUMN llm_provider_name DROP DEFAULT;

COMMENT ON COLUMN experience.openrouter_chat_history.llm_provider_name IS
  'Optional vendor selected by OpenRouter routing; the table itself identifies the OpenRouter caller.';

-- The first TEST backfill used the caller name as a placeholder. Restore the
-- routed vendor only on those known historical rows, preserving later writes.
UPDATE experience.openrouter_chat_history AS router
SET llm_provider_name = history.llm_provider_name,
    updated_at = now()
FROM experience.chat_history AS history
WHERE router.chat_history_id = history.id
  AND router.llm_provider_name = 'openrouter'
  AND history.llm_provider_name IS NOT NULL
  AND history.llm_billing_snapshot ->> 'provider' = 'openrouter';

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
  history.llm_provider_name,
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
  AND NOT EXISTS (
    SELECT 1
    FROM experience.venice_chat_history AS venice
    WHERE venice.chat_history_id = history.id
  )
ON CONFLICT (chat_history_id) DO NOTHING;

COMMIT;

-- Recovery: retain the parent compatibility columns and the one-to-one table.
-- If attribution evidence changes, stop writers and use a reviewed forward-fix;
-- never rerun or edit the previously recorded migration files.
