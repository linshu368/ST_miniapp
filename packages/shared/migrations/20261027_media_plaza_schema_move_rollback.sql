-- 20261027_media_plaza_schema_move_rollback.sql
-- domain: media_plaza
-- Emergency rollback for M1 only. It refuses to run after video objects exist.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regnamespace('media_plaza') IS NULL
     OR to_regclass('media_plaza.image_plaza_works') IS NULL THEN
    RAISE EXCEPTION 'media plaza M1 rollback prerequisites are absent';
  END IF;
  IF to_regclass('media_plaza.video_attempts') IS NOT NULL
     OR to_regclass('media_plaza.video_artifacts') IS NOT NULL
     OR to_regclass('media_plaza.video_quotes') IS NOT NULL THEN
    RAISE EXCEPTION 'media plaza M1 rollback is forbidden after M2';
  END IF;
END;
$$;

ALTER TABLE media_plaza.image_plaza_conversations SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_messages SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_quotes SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_reference_assets SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_attempts SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_artifacts SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_works SET SCHEMA experience;
ALTER TABLE media_plaza.image_plaza_likes SET SCHEMA miniapp_features;

ALTER FUNCTION media_plaza.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER)
  SET SCHEMA experience;
ALTER FUNCTION media_plaza.set_image_plaza_like(UUID, UUID, BOOLEAN)
  SET SCHEMA experience;
ALTER FUNCTION media_plaza.import_image_plaza_seed_work(
  TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) SET SCHEMA experience;

DO $$
DECLARE
  v_function OID;
  v_definition TEXT;
BEGIN
  FOR v_function IN
    SELECT proc.oid
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    WHERE (namespace.nspname, proc.proname) IN (
      ('experience', 'claim_image_plaza_jobs'),
      ('experience', 'set_image_plaza_like'),
      ('experience', 'import_image_plaza_seed_work'),
      ('billing', 'settle_image_plaza_generation'),
      ('billing', 'share_image_plaza_artifact')
    )
  LOOP
    SELECT pg_get_functiondef(v_function) INTO v_definition;
    v_definition := replace(
      replace(v_definition, 'media_plaza.image_plaza_', 'experience.image_plaza_'),
      'media_plaza.image_plaza_likes', 'miniapp_features.image_plaza_likes'
    );
    EXECUTE v_definition;
  END LOOP;
END;
$$;

DROP SCHEMA media_plaza;
NOTIFY pgrst, 'reload schema';
COMMIT;
