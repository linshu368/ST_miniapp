-- domain: app_core
-- Restore the text-postprocess snapshot read privilege required by conversation turn wrappers.
--
-- Preconditions:
--   - 20260928_text_postprocess_versions.sql and
--     20260928_chat_history_postprocess_version.sql have completed successfully.
--   - Both start_chat_history_*_with_postprocess wrappers remain SECURITY DEFINER owned by postgres.
--
-- Invariant:
--   The wrappers may verify a published snapshot before creating a conversation turn. postgres and
--   the server-only service_role may SELECT immutable snapshots; service_role must not mutate them.
--
-- Lock/capacity:
--   GRANT/REVOKE change only ACL metadata. There is no table rewrite, row scan, or backfill.
--
-- Recovery:
--   If preflight/postflight fails, stop before releasing the Backend change and investigate the
--   unexpected function owner or ACL drift. Do not weaken permissions with a broad schema grant.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_owner name;
  v_security_definer boolean;
  v_signature regprocedure;
BEGIN
  IF to_regclass('app_core.text_postprocess_versions') IS NULL
     OR to_regrole('postgres') IS NULL
     OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION '20260929_grant_text_postprocess_snapshot_read preflight: snapshot table or required role is missing';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'experience.start_chat_history_turn_with_postprocess(uuid,text,text,integer,integer,integer,integer)'::regprocedure,
    'experience.start_chat_history_regeneration_with_postprocess(uuid,integer,text,integer,integer,integer,integer)'::regprocedure
  ] LOOP
    SELECT pg_get_userbyid(p.proowner), p.prosecdef
      INTO v_owner, v_security_definer
    FROM pg_proc AS p
    WHERE p.oid = v_signature;

    IF v_owner IS DISTINCT FROM 'postgres' OR v_security_definer IS DISTINCT FROM true THEN
      RAISE EXCEPTION '20260929_grant_text_postprocess_snapshot_read preflight: % must be SECURITY DEFINER owned by postgres', v_signature;
    END IF;
  END LOOP;
END
$preflight$;

-- The wrapper's p_postprocess_version check reads this table as postgres. The Backend also reads
-- immutable snapshots as service_role to render historical messages; neither role receives writes.
GRANT SELECT ON TABLE app_core.text_postprocess_versions TO postgres, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE app_core.text_postprocess_versions FROM service_role;

DO $postflight$
BEGIN
  IF NOT has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'SELECT') THEN
    RAISE EXCEPTION 'postflight failed: postgres cannot read text-postprocess snapshots';
  END IF;
  IF NOT has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'SELECT') THEN
    RAISE EXCEPTION 'postflight failed: service_role cannot read text-postprocess snapshots';
  END IF;
  IF has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'INSERT')
     OR has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'UPDATE')
     OR has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'DELETE')
     OR has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'postflight failed: service_role gained a text-postprocess snapshot write privilege';
  END IF;
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';
