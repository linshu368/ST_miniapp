-- 20260917: Allow the Batch Lab source reader to see source rows protected by RLS.
-- domain: batch_lab
--
-- Background:
-- 20260920_batch_lab_samples.sql grants SELECT on the three source tables used for sample
-- assembly, but experience.chat_sessions and app_core.characters have RLS enabled.
-- Without explicit SELECT policies, the restricted source login can read chat_history
-- anchors but sees zero joined sessions/characters, so every preview is empty.
--
-- Rollback:
--   DROP POLICY IF EXISTS batch_lab_source_reader_select_chat_sessions ON experience.chat_sessions;
--   DROP POLICY IF EXISTS batch_lab_source_reader_select_characters ON app_core.characters;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_reader') THEN
    RAISE EXCEPTION 'batch_lab_source_reader role is missing; run 20260920_batch_lab_samples.sql first';
  END IF;
  IF to_regclass('experience.chat_sessions') IS NULL THEN
    RAISE EXCEPTION 'experience.chat_sessions is missing';
  END IF;
  IF to_regclass('app_core.characters') IS NULL THEN
    RAISE EXCEPTION 'app_core.characters is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'experience'
      AND tablename = 'chat_sessions'
      AND policyname = 'batch_lab_source_reader_select_chat_sessions'
  ) THEN
    CREATE POLICY batch_lab_source_reader_select_chat_sessions
      ON experience.chat_sessions
      FOR SELECT
      TO batch_lab_source_reader
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'app_core'
      AND tablename = 'characters'
      AND policyname = 'batch_lab_source_reader_select_characters'
  ) THEN
    CREATE POLICY batch_lab_source_reader_select_characters
      ON app_core.characters
      FOR SELECT
      TO batch_lab_source_reader
      USING (true);
  END IF;
END;
$$;

COMMENT ON POLICY batch_lab_source_reader_select_chat_sessions
  ON experience.chat_sessions IS
  'Allows the restricted Batch Lab source reader to assemble reproducible sample snapshots without granting write privileges or BYPASSRLS.';

COMMENT ON POLICY batch_lab_source_reader_select_characters
  ON app_core.characters IS
  'Allows the restricted Batch Lab source reader to assemble reproducible sample snapshots without granting write privileges or BYPASSRLS.';

COMMIT;

-- Manual verification after applying to test:
-- 1. Connect with batch_lab_source_login, not service_role/postgres.
-- 2. Run packages/backend script:
--      pnpm --filter @miniapp/backend batch-lab:verify-source
-- 3. Expected: sample visibility check passes and INSERT/UPDATE/DELETE/TRUNCATE/DDL checks remain denied.
