-- Domain: experience. Aggregate reply likes for a bounded set of characters using
-- chat_sessions(character_id,id) -> chat_message_likes(session_id,message_id).
-- Apply before enabling author-space counts. Run as a standalone file without BEGIN.
-- If interrupted, inspect validity and shape before retrying. Roll back the read path
-- first, then optionally DROP INDEX CONCURRENTLY experience.idx_chat_sessions_character_id_id.
SET lock_timeout = '5s';
SET statement_timeout = '5min';
SET maintenance_work_mem = '32MB';
SET max_parallel_maintenance_workers = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_sessions_character_id_id
  ON experience.chat_sessions (character_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
    WHERE i.indexrelid = 'experience.idx_chat_sessions_character_id_id'::regclass
      AND i.indrelid = 'experience.chat_sessions'::regclass
      AND i.indisvalid AND i.indisready AND NOT i.indisunique AND am.amname = 'btree'
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'character_id'
      AND pg_get_indexdef(i.indexrelid, 2, true) = 'id'
  ) THEN
    RAISE EXCEPTION 'Unexpected or invalid reply-like lookup index; inspect before retrying';
  END IF;
END $$;
