-- domain: admin
-- Fix the dedicated text-postprocess write guard for service_role RPC calls.
--
-- Preconditions:
--   - 20260928_text_postprocess_versions.sql has completed successfully.
--   - The five dedicated text-postprocess RPC signatures and their trigger guards exist.
--
-- Invariant:
--   Only a dedicated SECURITY DEFINER RPC can enable the transaction-local guard.
--   Generic config RPCs and direct Data API writes remain rejected by their existing triggers.
--
-- Lock/capacity:
--   CREATE OR REPLACE FUNCTION takes routine metadata locks only. No table rewrite, row scan, or
--   backfill occurs. Run as a single file through the Database Migration workflow.
--
-- Recovery:
--   If postflight fails, restore the prior two function definitions from
--   20260928_text_postprocess_versions.sql in a reviewed forward migration. This file does not
--   mutate drafts, releases, runtime_config values, snapshots, or audit rows.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.text_postprocess_writer_enter()') IS NULL
     OR to_regprocedure('admin.text_postprocess_writer_ok()') IS NULL
     OR to_regprocedure('admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260929_fix_text_postprocess_writer_guard preflight: text-postprocess RPC prerequisites missing';
  END IF;
END
$preflight$;

-- Temp-table ownership depends on the effective role at each SECURITY DEFINER / trigger boundary.
-- PostgREST service_role reaches those boundaries with a different current_user, so a valid publish
-- is rejected after its draft save succeeds. A transaction-local setting survives all boundaries of
-- one RPC call and disappears automatically when that call commits or rolls back.
CREATE OR REPLACE FUNCTION admin.text_postprocess_writer_enter()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  PERFORM pg_catalog.set_config('admin.text_postprocess_writer_guard', 'on', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.text_postprocess_writer_ok()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $fn$
BEGIN
  RETURN pg_catalog.current_setting('admin.text_postprocess_writer_guard', true) = 'on';
END;
$fn$;

REVOKE ALL ON FUNCTION admin.text_postprocess_writer_enter() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_writer_ok() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.text_postprocess_writer_ok() TO anon, authenticated, service_role, postgres;

DO $selfcheck$
DECLARE
  v_enter_source text;
  v_ok_source text;
  v_is_definer boolean;
BEGIN
  SELECT p.prosrc, p.prosecdef
    INTO STRICT v_enter_source, v_is_definer
  FROM pg_proc AS p
  WHERE p.oid = 'admin.text_postprocess_writer_enter()'::regprocedure;

  SELECT p.prosrc
    INTO v_ok_source
  FROM pg_proc AS p
  WHERE p.oid = 'admin.text_postprocess_writer_ok()'::regprocedure;

  IF NOT v_is_definer
     OR position('set_config' IN v_enter_source) = 0
     OR position('current_setting' IN v_ok_source) = 0 THEN
    RAISE EXCEPTION 'self-check failed: text-postprocess writer guard definition is incomplete';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND has_function_privilege(
       'service_role',
       'admin.text_postprocess_writer_enter()'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'self-check failed: service_role can enter the writer guard directly';
  END IF;
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
