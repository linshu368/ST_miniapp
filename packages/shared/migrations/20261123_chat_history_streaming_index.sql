-- domain: experience
-- Standalone psql migration: CONCURRENTLY must not run inside BEGIN/COMMIT.
-- Rollback: DROP INDEX CONCURRENTLY experience.idx_chat_history_streaming_created_id;
-- A failed concurrent build can leave an invalid index. Inspect pg_index, drop only
-- that invalid index concurrently, then rerun this unchanged file via the ledger runner.
SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_history_streaming_created_id
  ON experience.chat_history (created_at, id) WHERE status = 'streaming';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'experience.idx_chat_history_streaming_created_id'::regclass
      AND i.indisvalid AND i.indisready
      AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX idx_chat_history_streaming_created_id ON experience.chat_history USING btree (created_at, id) WHERE (status = ''streaming''::text)'
  ) THEN
    RAISE EXCEPTION 'Streaming index shape or validity differs';
  END IF;
END;
$$;
