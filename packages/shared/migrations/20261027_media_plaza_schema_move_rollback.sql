-- 20261027_media_plaza_schema_move_rollback.sql
-- domain: media_plaza
-- Emergency rollback for M1 only. It refuses to run after video objects exist.
-- While traffic remains paused, first restore the environment's pre-M1
-- pgrst.db_schemas value and reload PostgREST config/schema. Then run this file
-- and immediately redeploy the pre-M1 backend.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  IF to_regnamespace('media_plaza') IS NULL THEN
    RAISE EXCEPTION 'media plaza M1 rollback schema prerequisite is absent';
  END IF;

  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO v_missing
  FROM unnest(ARRAY[
    'media_plaza.image_plaza_conversations',
    'media_plaza.image_plaza_messages',
    'media_plaza.image_plaza_quotes',
    'media_plaza.image_plaza_reference_assets',
    'media_plaza.image_plaza_attempts',
    'media_plaza.image_plaza_artifacts',
    'media_plaza.image_plaza_works',
    'media_plaza.image_plaza_likes'
  ]) AS expected(name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class AS class
    WHERE class.oid = to_regclass(expected.name)
      AND class.relkind IN ('r', 'p')
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'media plaza M1 rollback missing base tables: %', v_missing;
  END IF;

  IF to_regprocedure('media_plaza.claim_image_plaza_jobs(text,integer,integer)') IS NULL
     OR to_regprocedure('media_plaza.set_image_plaza_like(uuid,uuid,boolean)') IS NULL
     OR to_regprocedure(
       'media_plaza.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
     ) IS NULL THEN
    RAISE EXCEPTION 'media plaza M1 rollback function shape differs from M1';
  END IF;

  IF to_regclass('media_plaza.video_attempts') IS NOT NULL
     OR to_regclass('media_plaza.video_artifacts') IS NOT NULL
     OR to_regclass('media_plaza.video_quotes') IS NOT NULL THEN
    RAISE EXCEPTION 'media plaza M1 rollback is forbidden after video objects exist';
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
    -- Restore likes first so the generic image_plaza_ replacement does not
    -- incorrectly place it in experience.
    v_definition := replace(
      replace(
        v_definition,
        'media_plaza.image_plaza_likes',
        'miniapp_features.image_plaza_likes'
      ),
      'media_plaza.image_plaza_',
      'experience.image_plaza_'
    );
    EXECUTE v_definition;
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  experience.image_plaza_conversations,
  experience.image_plaza_messages,
  experience.image_plaza_quotes,
  experience.image_plaza_reference_assets,
  experience.image_plaza_attempts,
  experience.image_plaza_artifacts,
  experience.image_plaza_works,
  miniapp_features.image_plaza_likes
FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE
  experience.image_plaza_conversations,
  experience.image_plaza_messages,
  experience.image_plaza_quotes,
  experience.image_plaza_reference_assets,
  experience.image_plaza_attempts,
  experience.image_plaza_artifacts,
  experience.image_plaza_works,
  miniapp_features.image_plaza_likes
TO service_role, postgres;

REVOKE ALL ON FUNCTION experience.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER)
  TO service_role, postgres;
REVOKE ALL ON FUNCTION experience.set_image_plaza_like(UUID, UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.set_image_plaza_like(UUID, UUID, BOOLEAN)
  TO service_role, postgres;
REVOKE ALL ON FUNCTION experience.import_image_plaza_seed_work(
  TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.import_image_plaza_seed_work(
  TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) TO service_role, postgres;

DROP SCHEMA media_plaza;

DO $$
BEGIN
  IF to_regnamespace('media_plaza') IS NOT NULL
     OR to_regclass('experience.image_plaza_works') IS NULL
     OR to_regclass('miniapp_features.image_plaza_likes') IS NULL
     OR (
       SELECT count(*)
       FROM pg_class AS class
       JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'experience'
         AND class.relkind IN ('r', 'p')
         AND class.relname::TEXT = ANY (ARRAY[
           'image_plaza_conversations',
           'image_plaza_messages',
           'image_plaza_quotes',
           'image_plaza_reference_assets',
           'image_plaza_attempts',
           'image_plaza_artifacts',
           'image_plaza_works'
         ])
     ) <> 7
     OR (
       SELECT count(*)
       FROM pg_class AS class
       JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'miniapp_features'
         AND class.relname = 'image_plaza_likes'
         AND class.relkind IN ('r', 'p')
     ) <> 1
     OR to_regprocedure('experience.claim_image_plaza_jobs(text,integer,integer)') IS NULL
     OR to_regprocedure('experience.set_image_plaza_like(uuid,uuid,boolean)') IS NULL
     OR to_regprocedure(
       'experience.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
     ) IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_proc AS proc
       WHERE proc.prosrc ~ 'media_plaza[.]image_plaza_'
     ) THEN
    RAISE EXCEPTION 'media plaza M1 rollback postflight mismatch';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
