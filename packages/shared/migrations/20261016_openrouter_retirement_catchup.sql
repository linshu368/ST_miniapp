-- domain: experience
-- Local delivery only. Execute one file at a time after the release checklist gates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Preserve only call scalars/identity. Prompt/reply/raw JSON and business finish_reason never move.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM experience.venice_chat_history v JOIN experience.openrouter_chat_history o USING(chat_history_id))
    THEN RAISE EXCEPTION 'Provider overlap; stop retirement'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
      WHERE h.llm_generation_id IS NOT NULL AND o.llm_generation_id IS NOT NULL AND h.llm_generation_id<>o.llm_generation_id)
    THEN RAISE EXCEPTION 'OpenRouter identity conflict'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
      WHERE h.llm_generation_id IS NOT NULL AND v.llm_generation_id IS NOT NULL AND h.llm_generation_id<>v.llm_generation_id)
    THEN RAISE EXCEPTION 'Venice identity conflict'; END IF;
END $$;

-- Materialize the small missing-scalar/identity set before touching potentially toasted snapshots.
CREATE TEMP TABLE retirement_candidates ON COMMIT DROP AS
SELECT h.id FROM experience.chat_history h
LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
WHERE v.chat_history_id IS NULL AND (
    h.llm_generation_id IS NOT NULL AND o.llm_generation_id IS NULL OR
    h.llm_provider_name IS NOT NULL AND o.provider_name IS NULL OR
    h.llm_usage IS NOT NULL AND o.usage IS NULL OR
    h.llm_usage_cache IS NOT NULL AND o.usage_cache IS NULL OR
    h.llm_native_tokens_cached IS NOT NULL AND o.native_tokens_cached IS NULL OR
    h.llm_native_tokens_reasoning IS NOT NULL AND o.native_tokens_reasoning IS NULL OR
    h.llm_native_tokens_completion IS NOT NULL AND o.native_tokens_completion IS NULL OR
    h.llm_native_tokens_prompt IS NOT NULL AND o.native_tokens_prompt IS NULL OR
    h.llm_latency IS NOT NULL AND o.latency IS NULL OR
    h.llm_generation_time IS NOT NULL AND o.generation_time IS NULL OR
    h.llm_model IS NOT NULL AND o.model IS NULL
);
DO $$ BEGIN
  IF (SELECT count(*) FROM retirement_candidates)>2000
    THEN RAISE EXCEPTION 'Catch-up exceeds validated 2000-row budget; review bounded batches'; END IF;
  IF EXISTS (SELECT 1 FROM retirement_candidates c JOIN experience.chat_history h USING(id)
    WHERE h.llm_billing_snapshot->>'provider'='venice')
    THEN RAISE EXCEPTION 'Venice snapshot without Venice detail'; END IF;
END $$;

INSERT INTO experience.openrouter_chat_history (chat_history_id,llm_generation_id,provider_name, usage, usage_cache, native_tokens_cached, native_tokens_reasoning, native_tokens_completion, native_tokens_prompt, latency, generation_time, model,created_at)
SELECT h.id,h.llm_generation_id,h.llm_provider_name,CASE WHEN jsonb_typeof(h.llm_usage)='number' THEN CASE WHEN (h.llm_usage #>> '{}')::numeric >= 0 THEN h.llm_usage END END,CASE WHEN jsonb_typeof(h.llm_usage_cache)='number' THEN CASE WHEN (h.llm_usage_cache #>> '{}')::numeric >= 0 THEN h.llm_usage_cache END END,CASE WHEN h.llm_native_tokens_cached >= 0 THEN h.llm_native_tokens_cached END,CASE WHEN h.llm_native_tokens_reasoning >= 0 THEN h.llm_native_tokens_reasoning END,CASE WHEN h.llm_native_tokens_completion >= 0 THEN h.llm_native_tokens_completion END,CASE WHEN h.llm_native_tokens_prompt >= 0 THEN h.llm_native_tokens_prompt END,CASE WHEN h.llm_latency >= 0 THEN h.llm_latency END,CASE WHEN h.llm_generation_time >= 0 THEN h.llm_generation_time END,h.llm_model,h.created_at
FROM retirement_candidates c JOIN experience.chat_history h USING(id)
WHERE h.llm_generation_id IS NOT NULL OR h.llm_billing_snapshot->>'provider'='openrouter'
ON CONFLICT (chat_history_id) DO UPDATE SET
    llm_generation_id=COALESCE(experience.openrouter_chat_history.llm_generation_id,EXCLUDED.llm_generation_id),
    provider_name=COALESCE(experience.openrouter_chat_history.provider_name, EXCLUDED.provider_name),
    usage=COALESCE(experience.openrouter_chat_history.usage, EXCLUDED.usage),
    usage_cache=COALESCE(experience.openrouter_chat_history.usage_cache, EXCLUDED.usage_cache),
    native_tokens_cached=COALESCE(experience.openrouter_chat_history.native_tokens_cached, EXCLUDED.native_tokens_cached),
    native_tokens_reasoning=COALESCE(experience.openrouter_chat_history.native_tokens_reasoning, EXCLUDED.native_tokens_reasoning),
    native_tokens_completion=COALESCE(experience.openrouter_chat_history.native_tokens_completion, EXCLUDED.native_tokens_completion),
    native_tokens_prompt=COALESCE(experience.openrouter_chat_history.native_tokens_prompt, EXCLUDED.native_tokens_prompt),
    latency=COALESCE(experience.openrouter_chat_history.latency, EXCLUDED.latency),
    generation_time=COALESCE(experience.openrouter_chat_history.generation_time, EXCLUDED.generation_time),
    model=COALESCE(experience.openrouter_chat_history.model, EXCLUDED.model), updated_at=now();

-- Venice owns its own identity; no metadata mapper/schema change.
UPDATE experience.venice_chat_history v SET llm_generation_id=h.llm_generation_id,updated_at=now()
FROM experience.chat_history h WHERE h.id=v.chat_history_id
AND v.llm_generation_id IS NULL AND h.llm_generation_id IS NOT NULL;
COMMIT;
-- Recovery: retain additive detail rows; conflicts/oversize roll back the entire file.
