\set ON_ERROR_STOP 1
-- account deletion cascades
DELETE FROM app_core.users WHERE id='a1000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM experience.story_memories) OR EXISTS (SELECT 1 FROM experience.story_memory_jobs) THEN
    RAISE EXCEPTION 'story memory rows survived account deletion';
  END IF;
END $$;
