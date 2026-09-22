-- 20260922: Remove Batch Lab database objects after retiring the internal workbench.
-- domain: batch_lab
--
-- Scope:
--   - Drops the batch_lab schema, including all Batch Lab tables, functions, indexes,
--     triggers, policies, comments and grants inside that schema.
--   - Removes source-reader RLS policies added to app_core/experience for Batch Lab.
--   - Removes the dedicated Batch Lab source-reader roles and their database grants.
--
-- Preconditions:
--   - Disable Batch Lab backend routes/workers and remove deployed clients before applying.
--   - Preserve any audit/export data that must survive this cleanup.
--   - This migration intentionally fails if queued/running experiments are still present.
--
-- Rollback / recovery:
--   This is data-destructive. Recovery requires database backup/PITR, or a reviewed
--   forward migration that recreates the required objects from the 20260916/20260917/
--   20260920 Batch Lab migrations and restores preserved data. Do not edit or rerun
--   already-ledgered historical migrations to recover.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  v_active_count INTEGER;
BEGIN
  IF to_regclass('batch_lab.experiments') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'batch_lab'
        AND table_name = 'experiments'
        AND column_name = 'deleted_at'
    ) THEN
      EXECUTE
        'SELECT count(*)::integer FROM batch_lab.experiments WHERE status IN (''queued'', ''running'') AND deleted_at IS NULL'
      INTO v_active_count;
    ELSE
      EXECUTE
        'SELECT count(*)::integer FROM batch_lab.experiments WHERE status IN (''queued'', ''running'')'
      INTO v_active_count;
    END IF;

    IF v_active_count > 0 THEN
      RAISE EXCEPTION 'BATCH_LAB_ACTIVE_EXPERIMENTS_EXIST: stop active experiments before dropping Batch Lab objects'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regclass('experience.chat_sessions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS batch_lab_source_reader_select_chat_sessions ON experience.chat_sessions';
  END IF;

  IF to_regclass('app_core.characters') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS batch_lab_source_reader_select_characters ON app_core.characters';
  END IF;
END;
$$;

DROP SCHEMA IF EXISTS batch_lab CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_login')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_reader') THEN
    REVOKE batch_lab_source_reader FROM batch_lab_source_login;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_login') THEN
    DROP OWNED BY batch_lab_source_login;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_reader') THEN
    DROP OWNED BY batch_lab_source_reader;
  END IF;

  DROP ROLE IF EXISTS batch_lab_source_login;
  DROP ROLE IF EXISTS batch_lab_source_reader;
END;
$$;

COMMIT;

-- Post-apply verification, test first:
-- 1. SELECT to_regnamespace('batch_lab') IS NULL AS batch_lab_schema_removed; -- must be true
-- 2. SELECT count(*) FROM pg_roles WHERE rolname IN ('batch_lab_source_login', 'batch_lab_source_reader'); -- must be 0
-- 3. SELECT count(*) FROM pg_policies
--      WHERE policyname IN (
--        'batch_lab_source_reader_select_chat_sessions',
--        'batch_lab_source_reader_select_characters'
--      ); -- must be 0
-- 4. Confirm Batch Lab backend routes/workers are disabled before production apply.
