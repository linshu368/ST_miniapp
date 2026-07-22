-- 054_simulation_card_evaluation.sql
-- Test-card identity and physically isolated simulation conversations.

BEGIN;

ALTER TABLE miniapp.characters
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS card_hash TEXT;

ALTER TABLE miniapp.characters
  DROP CONSTRAINT IF EXISTS characters_test_cards_disabled;
ALTER TABLE miniapp.characters
  ADD CONSTRAINT characters_test_cards_disabled
  CHECK (NOT is_test OR (enabled = false AND card_hash IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_card_hash_unique
  ON miniapp.characters(card_hash)
  WHERE card_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_characters_test_name
  ON miniapp.characters(name)
  WHERE is_test = true;

COMMENT ON COLUMN miniapp.characters.is_test IS
  'True only for pre-release evaluation cards. Test cards must remain disabled.';
COMMENT ON COLUMN miniapp.characters.card_hash IS
  'Lowercase SHA-256 of the original imported card file bytes.';

CREATE SCHEMA IF NOT EXISTS miniapp_simulation;

CREATE TABLE IF NOT EXISTS miniapp_simulation.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE RESTRICT,
  card_hash TEXT NOT NULL,
  st_handle TEXT NOT NULL UNIQUE,
  st_chat_id TEXT,
  requested_model_id TEXT,
  effective_model_id TEXT,
  preset_id UUID,
  current_turn_id UUID,
  current_turn_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'ready', 'busy', 'failed', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_simulation_conversations_character
  ON miniapp_simulation.conversations(character_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_simulation_conversations_active
  ON miniapp_simulation.conversations(last_active_at DESC)
  WHERE status <> 'closed';

CREATE TABLE IF NOT EXISTS miniapp_simulation.chat_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  model TEXT NOT NULL,
  user_input TEXT NOT NULL,
  assistant_reply TEXT,
  history JSONB NOT NULL,
  character_id UUID REFERENCES miniapp.characters(id) ON DELETE SET NULL,
  preset_id UUID,
  status TEXT NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'upstream_error', 'stream_interrupted')),
  upstream_status INTEGER,
  deduction_rate NUMERIC(14,1) NOT NULL DEFAULT 0,
  user_character_round INTEGER,
  llm_provider_name TEXT,
  llm_finish_reason TEXT,
  llm_usage JSONB,
  llm_usage_cache JSONB,
  llm_native_tokens_cached INTEGER,
  llm_native_tokens_reasoning INTEGER,
  llm_native_tokens_completion INTEGER,
  llm_native_tokens_prompt INTEGER,
  llm_latency NUMERIC,
  llm_generation_time NUMERIC,
  llm_model TEXT,
  llm_generation_id TEXT,
  llm_generation_data JSONB,
  llm_model_markup NUMERIC(4,1),
  llm_intended_deduction NUMERIC(14,1),
  llm_charge_id UUID,
  conversation_id UUID NOT NULL
    REFERENCES miniapp_simulation.conversations(id) ON DELETE CASCADE,
  round_index INTEGER NOT NULL,
  is_simulation BOOLEAN NOT NULL DEFAULT true CHECK (is_simulation = true),
  source TEXT NOT NULL DEFAULT 'card_screening_agent',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  effective_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, round_index)
);

CREATE INDEX IF NOT EXISTS idx_simulation_chat_log_conversation
  ON miniapp_simulation.chat_log(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_simulation_chat_log_character
  ON miniapp_simulation.chat_log(character_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_simulation_chat_log_model
  ON miniapp_simulation.chat_log(model, created_at DESC);

CREATE OR REPLACE FUNCTION miniapp_simulation.tf_set_round_index()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.round_index IS NULL OR NEW.round_index < 1 THEN
    SELECT COALESCE(MAX(log.round_index), 0) + 1
      INTO NEW.round_index
      FROM miniapp_simulation.chat_log AS log
     WHERE log.conversation_id = NEW.conversation_id;
  END IF;
  NEW.user_character_round := NEW.round_index;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_simulation_round_index
  ON miniapp_simulation.chat_log;
CREATE TRIGGER trg_set_simulation_round_index
BEFORE INSERT ON miniapp_simulation.chat_log
FOR EACH ROW
EXECUTE FUNCTION miniapp_simulation.tf_set_round_index();

ALTER TABLE miniapp_simulation.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_simulation.chat_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA miniapp_simulation FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA miniapp_simulation FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA miniapp_simulation FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA miniapp_simulation TO service_role, postgres;
GRANT ALL ON ALL TABLES IN SCHEMA miniapp_simulation TO service_role, postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA miniapp_simulation TO service_role, postgres;

COMMENT ON SCHEMA miniapp_simulation IS
  'Physically isolated pre-release card evaluation traffic.';
COMMENT ON TABLE miniapp_simulation.chat_log IS
  'One row per simulated LLM turn. Never included in production analytics or billing.';

COMMIT;
