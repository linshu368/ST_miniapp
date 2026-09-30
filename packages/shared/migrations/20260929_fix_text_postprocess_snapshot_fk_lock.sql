-- domain: app_core
-- Foreign-key checks lock referenced snapshots with SELECT FOR KEY SHARE. PostgreSQL requires
-- UPDATE on at least one column for that lock, even when SELECT has already been granted.
-- Preconditions: the snapshot table and both conversation wrappers exist, belong to postgres,
-- and retain RLS, the version FK, and ENABLE ALWAYS immutable/no-truncate triggers.
-- This file changes ACL metadata only, with no row scan, backfill, new objects, or API changes.
-- Recovery: a failed preflight/postflight rolls back the transaction. After commit, use a reviewed
-- forward-fix; keep snapshots, FK, and immutable triggers, and do not restore broad role grants.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_signature regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'app_core.text_postprocess_versions'::regclass
      AND relowner = 'postgres'::regrole AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'snapshot FK lock preflight: expected postgres-owned snapshot table with RLS';
  END IF;
  FOREACH v_signature IN ARRAY ARRAY[
    'experience.start_chat_history_turn_with_postprocess(uuid,text,text,integer,integer,integer,integer)'::regprocedure,
    'experience.start_chat_history_regeneration_with_postprocess(uuid,integer,text,integer,integer,integer,integer)'::regprocedure
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE oid = v_signature
        AND proowner = 'postgres'::regrole AND prosecdef
    ) THEN
      RAISE EXCEPTION 'snapshot FK lock preflight: % must remain postgres-owned SECURITY DEFINER', v_signature;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'experience.chat_history'::regclass
      AND confrelid = 'app_core.text_postprocess_versions'::regclass
      AND conname = 'chat_history_postprocess_version_fkey' AND contype = 'f' AND convalidated
  ) THEN
    RAISE EXCEPTION 'snapshot FK lock preflight: validated conversation version FK is missing';
  END IF;
  IF (
    SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'app_core.text_postprocess_versions'::regclass
      AND tgname IN ('trg_text_postprocess_versions_immutable', 'trg_text_postprocess_versions_no_truncate')
      AND tgfoid = 'app_core.guard_text_postprocess_version_write()'::regprocedure
      AND tgenabled = 'A' AND NOT tgisinternal
  ) <> 2 THEN
    RAISE EXCEPTION 'snapshot FK lock preflight: ENABLE ALWAYS snapshot write guards are missing';
  END IF;
END
$preflight$;

-- postgres inherits Supabase API roles. Remove emergency grants from those roles before granting
-- the owner a single lock-capable column; otherwise inherited UPDATE would conceal this defect.
REVOKE ALL ON TABLE app_core.text_postprocess_versions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL (version, source, artifact, schema_version, policy_version, published_at)
  ON TABLE app_core.text_postprocess_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE app_core.text_postprocess_versions TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app_core.text_postprocess_versions FROM postgres;
REVOKE UPDATE (version, source, artifact, schema_version, policy_version, published_at)
  ON TABLE app_core.text_postprocess_versions FROM postgres;
GRANT SELECT, INSERT ON TABLE app_core.text_postprocess_versions TO postgres;
GRANT UPDATE (version) ON TABLE app_core.text_postprocess_versions TO postgres;

DO $postflight$
DECLARE
  v_role name;
  v_column name;
BEGIN
  IF NOT has_column_privilege('postgres', 'app_core.text_postprocess_versions', 'version', 'UPDATE')
     OR NOT has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'SELECT')
     OR NOT has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'INSERT')
     OR has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'UPDATE')
     OR has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'DELETE')
     OR has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'snapshot FK lock postflight: unexpected owner privileges';
  END IF;
  FOREACH v_column IN ARRAY ARRAY['source', 'artifact', 'schema_version', 'policy_version', 'published_at']::name[] LOOP
    IF has_column_privilege('postgres', 'app_core.text_postprocess_versions', v_column, 'UPDATE') THEN
      RAISE EXCEPTION 'snapshot FK lock postflight: unexpected owner UPDATE on %', v_column;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::name[] LOOP
    IF has_any_column_privilege(v_role, 'app_core.text_postprocess_versions', 'INSERT')
       OR has_any_column_privilege(v_role, 'app_core.text_postprocess_versions', 'UPDATE')
       OR has_table_privilege(v_role, 'app_core.text_postprocess_versions', 'DELETE')
       OR has_table_privilege(v_role, 'app_core.text_postprocess_versions', 'TRUNCATE')
       OR (v_role <> 'service_role' AND has_any_column_privilege(v_role, 'app_core.text_postprocess_versions', 'SELECT')) THEN
      RAISE EXCEPTION 'snapshot FK lock postflight: unexpected API role privileges for %', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'SELECT') THEN
    RAISE EXCEPTION 'snapshot FK lock postflight: Backend snapshot SELECT is missing';
  END IF;
  -- EXPLAIN performs permission checks without executing the locking query or reading rows.
  EXECUTE 'EXPLAIN SELECT version FROM app_core.text_postprocess_versions WHERE false FOR KEY SHARE';
END
$postflight$;

COMMIT;
NOTIFY pgrst, 'reload schema';
