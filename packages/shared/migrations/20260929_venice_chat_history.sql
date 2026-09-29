-- domain: experience
-- Venice provider response/usage details are intentionally separated from
-- experience.chat_history. The parent remains the only source of conversation
-- content and billing outcome; this table stores one bounded metadata row per
-- Venice-backed turn for cost observation and provider troubleshooting.

BEGIN;

CREATE TABLE experience.venice_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_history_id uuid NOT NULL,
  llm_provider_name text NOT NULL DEFAULT 'venice',
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
  CONSTRAINT venice_chat_history_chat_history_id_key UNIQUE (chat_history_id),
  CONSTRAINT venice_chat_history_parent_fk
    FOREIGN KEY (chat_history_id)
    REFERENCES experience.chat_history(id)
    ON DELETE CASCADE,
  CONSTRAINT venice_chat_history_provider_check CHECK (llm_provider_name = 'venice'),
  CONSTRAINT venice_chat_history_usage_number_check
    CHECK (llm_usage IS NULL OR jsonb_typeof(llm_usage) = 'number'),
  CONSTRAINT venice_chat_history_usage_cache_number_check
    CHECK (llm_usage_cache IS NULL OR jsonb_typeof(llm_usage_cache) = 'number'),
  CONSTRAINT venice_chat_history_cached_tokens_check
    CHECK (llm_native_tokens_cached IS NULL OR llm_native_tokens_cached >= 0),
  CONSTRAINT venice_chat_history_reasoning_tokens_check
    CHECK (llm_native_tokens_reasoning IS NULL OR llm_native_tokens_reasoning >= 0),
  CONSTRAINT venice_chat_history_completion_tokens_check
    CHECK (llm_native_tokens_completion IS NULL OR llm_native_tokens_completion >= 0),
  CONSTRAINT venice_chat_history_prompt_tokens_check
    CHECK (llm_native_tokens_prompt IS NULL OR llm_native_tokens_prompt >= 0),
  CONSTRAINT venice_chat_history_latency_check CHECK (llm_latency IS NULL OR llm_latency >= 0),
  CONSTRAINT venice_chat_history_generation_time_check
    CHECK (llm_generation_time IS NULL OR llm_generation_time >= 0)
);

CREATE INDEX venice_chat_history_generation_id_idx
  ON experience.venice_chat_history (llm_generation_id)
  WHERE llm_generation_id IS NOT NULL;

CREATE INDEX venice_chat_history_created_at_idx
  ON experience.venice_chat_history (created_at DESC);

COMMENT ON TABLE experience.venice_chat_history IS
  'One-to-one Venice provider response and usage details for a parent chat turn; never stores prompt or reply content.';
COMMENT ON COLUMN experience.venice_chat_history.chat_history_id IS
  'Idempotency key and parent experience.chat_history row; deleted with the parent turn.';
COMMENT ON COLUMN experience.venice_chat_history.llm_usage IS
  'Estimated total Venice USD cost as a JSON number, matching chat_history.llm_usage semantics.';
COMMENT ON COLUMN experience.venice_chat_history.llm_generation_data IS
  'Bounded Venice response metadata; choices, message content and prompt text are excluded.';
COMMENT ON COLUMN experience.venice_chat_history.llm_latency IS
  'Milliseconds from upstream request start to first content token.';
COMMENT ON COLUMN experience.venice_chat_history.llm_generation_time IS
  'Milliseconds from upstream request start to response body completion.';

REVOKE ALL ON TABLE experience.venice_chat_history FROM anon, authenticated;
GRANT ALL ON TABLE experience.venice_chat_history TO service_role, postgres;

COMMIT;

-- Rollback (only after stopping Venice traffic):
-- DROP TABLE experience.venice_chat_history;