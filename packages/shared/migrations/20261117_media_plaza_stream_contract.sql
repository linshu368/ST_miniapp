-- domain: media_plaza
-- ONLY AFTER all TEST assets have been mapped/verified and all old workers have exited.
-- Recovery requires a Stream-capable application; source deletion is a separate verified step.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM media_plaza.video_artifacts WHERE stream_uid IS NULL OR playback_url IS NULL) THEN
    RAISE EXCEPTION 'Stream asset migration incomplete';
  END IF;
  IF EXISTS(SELECT 1 FROM media_plaza.video_attempts WHERE status IN ('submitting','queued','processing','storing')) THEN
    RAISE EXCEPTION 'Stop and drain video workers before contraction';
  END IF;
END $$;
ALTER TABLE media_plaza.video_artifacts ALTER COLUMN stream_uid SET NOT NULL;
ALTER TABLE media_plaza.video_artifacts ALTER COLUMN playback_url SET NOT NULL;
DROP FUNCTION media_plaza.import_video_seed_work(TEXT,TEXT,INTEGER,TEXT,BIGINT,INTEGER,INTEGER,INTEGER,TEXT,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ);
ALTER TABLE media_plaza.video_artifacts DROP COLUMN storage_path RESTRICT;
NOTIFY pgrst,'reload schema';
COMMIT;
