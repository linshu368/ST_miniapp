-- domain: experience
-- OpenRouter generation metadata is separate from the parent conversation and
-- billing facts. The parent retains the business terminal state and all charge
-- settlement columns; this table is a one-to-one, bounded provider record.

BEGIN;

CREATE TABLE experience.openrouter_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_history_id uuid NOT NULL,
  llm_provider_name text NOT NULL DEFAULT 'openrouter',
  llm_finish_reason text,
  llm_usage jsonb,
  llm_usage_cache jsonb,
  llm_native_tokens_cached integer,
  llm_native_tokens_reasoning integer,
  llm_native_tokens_completion integer,
  llm_native_tokens_prompt integer,
  llm_latency numeric,
  llm_generation_time numeric,
  llm_model text,
  llm_generation_id text,
  llm_generation_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT openrouter_chat_history_chat_history_id_key UNIQUE (chat_history_id),
  CONSTRAINT openrouter_chat_history_parent_fk
    FOREIGN KEY (chat_history_id)
    REFERENCES experience.chat_history(id)
    ON DELETE CASCADE,
  CONSTRAINT openrouter_chat_history_provider_check CHECK (llm_provider_name = 'openrouter'),
  CONSTRAINT openrouter_chat_history_usage_number_check
    CHECK (llm_usage IS NULL OR jsonb_typeof(llm_usage) = 'number'),
  CONSTRAINT openrouter_chat_history_usage_cache_number_check
    CHECK (llm_usage_cache IS NULL OR jsonb_typeof(llm_usage_cache) = 'number'),
  CONSTRAINT openrouter_chat_history_cached_tokens_check
    CHECK (llm_native_tokens_cached IS NULL OR llm_native_tokens_cached >= 0),
  CONSTRAINT openrouter_chat_history_reasoning_tokens_check
    CHECK (llm_native_tokens_reasoning IS NULL OR llm_native_tokens_reasoning >= 0),
  CONSTRAINT openrouter_chat_history_completion_tokens_check
    CHECK (llm_native_tokens_completion IS NULL OR llm_native_tokens_completion >= 0),
  CONSTRAINT openrouter_chat_history_prompt_tokens_check
    CHECK (llm_native_tokens_prompt IS NULL OR llm_native_tokens_prompt >= 0),
  CONSTRAINT openrouter_chat_history_latency_check CHECK (llm_latency IS NULL OR llm_latency >= 0),
  CONSTRAINT openrouter_chat_history_generation_time_check
    CHECK (llm_generation_time IS NULL OR llm_generation_time >= 0)
);

CREATE INDEX openrouter_chat_history_generation_id_idx
  ON experience.openrouter_chat_history (llm_generation_id)
  WHERE llm_generation_id IS NOT NULL;

CREATE INDEX openrouter_chat_history_created_at_idx
  ON experience.openrouter_chat_history (created_at DESC);

COMMENT ON TABLE experience.openrouter_chat_history IS
  'One-to-one OpenRouter response and usage metadata for a parent chat turn; never stores prompt or reply content.';
COMMENT ON COLUMN experience.openrouter_chat_history.chat_history_id IS
  'Idempotency key and parent experience.chat_history row; deleted with the parent turn.';
COMMENT ON COLUMN experience.openrouter_chat_history.llm_finish_reason IS
  'Raw upstream OpenRouter finish reason; parent chat_history.llm_finish_reason remains the business terminal state.';
COMMENT ON COLUMN experience.openrouter_chat_history.llm_generation_data IS
  'OpenRouter generation response metadata only; prompt, reply content and credentials are excluded by the Backend mapper.';

REVOKE ALL ON TABLE experience.openrouter_chat_history FROM anon, authenticated;
GRANT ALL ON TABLE experience.openrouter_chat_history TO service_role, postgres;

COMMIT;

-- Forward-fix / rollback: stop the new Backend writer before DROP TABLE.
-- The parent chat_history compatibility columns are intentionally retained.
