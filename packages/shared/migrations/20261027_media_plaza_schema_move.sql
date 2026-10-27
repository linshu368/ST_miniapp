-- 20261027_media_plaza_schema_move.sql
-- domain: media_plaza
--
-- M1: move the existing image plaza catalog into its product domain without
-- rewriting rows. Billing facts and RPCs intentionally remain in billing.
-- Preflight: 20261012 image plaza plus seed catalog must already be present.
-- Recovery: use the paired rollback only before M2 creates video objects.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  IF to_regnamespace('media_plaza') IS NOT NULL THEN
    RAISE EXCEPTION 'media_plaza schema already exists';
  END IF;

  SELECT array_agg(expected.name ORDER BY expected.name)
  INTO v_missing
  FROM unnest(ARRAY[
    'experience.image_plaza_conversations',
    'experience.image_plaza_messages',
    'experience.image_plaza_quotes',
    'experience.image_plaza_reference_assets',
    'experience.image_plaza_attempts',
    'experience.image_plaza_artifacts',
    'experience.image_plaza_works',
    'miniapp_features.image_plaza_likes'
  ]) AS expected(name)
  WHERE to_regclass(expected.name) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'media plaza M1 missing prerequisite tables: %', v_missing;
  END IF;

  IF to_regprocedure('experience.claim_image_plaza_jobs(text,integer,integer)') IS NULL
     OR to_regprocedure('experience.set_image_plaza_like(uuid,uuid,boolean)') IS NULL
     OR to_regprocedure(
       'experience.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
     ) IS NULL
     OR to_regprocedure('billing.settle_image_plaza_generation(uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)') IS NULL THEN
    RAISE EXCEPTION 'media plaza M1 function shape differs from the reviewed baseline';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    WHERE proc.prosrc ~ '(experience[.]image_plaza_|miniapp_features[.]image_plaza_)'
      AND (namespace.nspname, proc.proname) NOT IN (
        ('experience', 'claim_image_plaza_jobs'),
        ('experience', 'set_image_plaza_like'),
        ('experience', 'import_image_plaza_seed_work'),
        ('billing', 'settle_image_plaza_generation'),
        ('billing', 'share_image_plaza_artifact')
      )
  ) THEN
    RAISE EXCEPTION 'media plaza M1 found an unreviewed function dependency';
  END IF;
END;
$$;

CREATE SCHEMA media_plaza AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA media_plaza FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA media_plaza TO service_role, postgres;

ALTER TABLE experience.image_plaza_conversations SET SCHEMA media_plaza;
ALTER TABLE experience.image_plaza_messages SET SCHEMA media_plaza;
ALTER TABLE experience.image_plaza_quotes SET SCHEMA media_plaza;
ALTER TABLE experience.image_plaza_reference_assets SET SCHEMA media_plaza;
ALTER TABLE experience.image_plaza_attempts SET SCHEMA media_plaza;
ALTER TABLE experience.image_plaza_artifacts SET SCHEMA media_plaza;
ALTER TABLE experience.image_plaza_works SET SCHEMA media_plaza;
ALTER TABLE miniapp_features.image_plaza_likes SET SCHEMA media_plaza;

ALTER FUNCTION experience.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER)
  SET SCHEMA media_plaza;
ALTER FUNCTION experience.set_image_plaza_like(UUID, UUID, BOOLEAN)
  SET SCHEMA media_plaza;
ALTER FUNCTION experience.import_image_plaza_seed_work(
  TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) SET SCHEMA media_plaza;

-- SET SCHEMA follows catalog OIDs, but schema-qualified names embedded in
-- PL/pgSQL bodies are plain text. Recompile only the five reviewed functions.
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
      ('media_plaza', 'claim_image_plaza_jobs'),
      ('media_plaza', 'set_image_plaza_like'),
      ('media_plaza', 'import_image_plaza_seed_work'),
      ('billing', 'settle_image_plaza_generation'),
      ('billing', 'share_image_plaza_artifact')
    )
  LOOP
    SELECT pg_get_functiondef(v_function) INTO v_definition;
    v_definition := replace(
      replace(v_definition, 'experience.image_plaza_', 'media_plaza.image_plaza_'),
      'miniapp_features.image_plaza_likes', 'media_plaza.image_plaza_likes'
    );
    EXECUTE v_definition;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname IN ('experience', 'miniapp_features')
      AND class.relname LIKE 'image_plaza_%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc AS proc
    WHERE proc.prosrc ~ '(experience[.]image_plaza_|miniapp_features[.]image_plaza_)'
  ) THEN
    RAISE EXCEPTION 'media plaza M1 postflight found stale schema-qualified references';
  END IF;

  IF (SELECT count(*) FROM pg_class AS class
      JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'media_plaza' AND class.relkind IN ('r', 'p')
        AND class.relname LIKE 'image_plaza_%') <> 8 THEN
    RAISE EXCEPTION 'media plaza M1 postflight table count mismatch';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
