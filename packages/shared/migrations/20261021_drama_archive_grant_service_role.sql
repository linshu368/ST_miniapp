-- domain: drama_archive (ungoverned; not yet registered in schema-and-object-conventions.md's
-- eight-domain map, see Open Issue in .trellis/tasks/10-21-drama-archive-access/prd.md, deferred
-- to a follow-up phase)
--
-- Grant the ST_miniAPP backend's service_role access to the drama_archive schema that
-- telegram-video-archive provisioned directly against the Supabase test project (this repo's
-- migrations are not that schema's origin).
--
-- Preconditions (verified live against the test project on 2026-10-21, not assumed from the
-- upstream migration's source):
--   - drama_archive.dramas/videos/ai_results/pipeline_tasks exist (created by
--     telegram-video-archive/migrations/001_pipeline.sql against the test project).
--   - service_role currently lacks USAGE on the drama_archive schema -- this is the only gate
--     blocking it today. service_role ALREADY holds table-level SELECT/INSERT/UPDATE/DELETE on
--     all four tables (information_schema.role_table_grants), a pre-existing grant this migration
--     did not create and does not touch; without schema USAGE those table grants are inert.
--     service_role also has rolbypassrls = true (pg_roles), so once USAGE is granted it reads and
--     writes all four tables' rows directly, RLS notwithstanding (the tables have RLS enabled with
--     zero policies, which only gates roles that do not bypass RLS, e.g. anon/authenticated).
--   - anon/authenticated also lack USAGE on the schema today; this migration does not touch them.
--
-- Invariant:
--   service_role gains the ability to use drama_archive's existing table-level grants (full
--   read/write on dramas/videos/ai_results/pipeline_tasks). This is an intentional scope decision
--   (confirmed 2026-10-21): prd.md's original "read-only, pipeline_tasks excluded" criteria were
--   relaxed because the backend will need read/write access to these tables later and the
--   pre-existing table grants already cover it; the constraint that still holds is that no other
--   schema's privileges change, and anon/authenticated/drama_worker's existing grants are
--   untouched.
--
-- Lock/capacity:
--   GRANT changes only ACL metadata. No table rewrite, row scan, or backfill.
--
-- Recovery:
--   `REVOKE USAGE ON SCHEMA drama_archive FROM service_role;` undoes this cleanly (it re-closes
--   the only gate service_role was missing); it does not affect drama_worker's function-based
--   access path, anon/authenticated, or any existing data.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regnamespace('drama_archive') IS NULL THEN
    RAISE EXCEPTION '20261021_drama_archive_grant_service_role preflight: schema drama_archive is missing';
  END IF;

  IF to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION '20261021_drama_archive_grant_service_role preflight: role service_role is missing';
  END IF;

  IF has_schema_privilege('service_role', 'drama_archive', 'USAGE') THEN
    RAISE EXCEPTION '20261021_drama_archive_grant_service_role preflight: service_role already has drama_archive schema USAGE, refusing to assume a clean baseline';
  END IF;
END
$preflight$;

GRANT USAGE ON SCHEMA drama_archive TO service_role;

DO $postflight$
BEGIN
  IF NOT has_schema_privilege('service_role', 'drama_archive', 'USAGE') THEN
    RAISE EXCEPTION 'postflight failed: service_role cannot USAGE the drama_archive schema';
  END IF;

  IF has_schema_privilege('anon', 'drama_archive', 'USAGE')
     OR has_schema_privilege('authenticated', 'drama_archive', 'USAGE') THEN
    RAISE EXCEPTION 'postflight failed: anon/authenticated unexpectedly gained drama_archive schema USAGE';
  END IF;
END
$postflight$;

COMMIT;
