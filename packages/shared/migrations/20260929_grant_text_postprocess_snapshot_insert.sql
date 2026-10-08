-- domain: app_core
-- Restore the dedicated text-postprocess SECURITY DEFINER publisher's minimal table privilege.
--
-- Preconditions:
--   - 20260928_text_postprocess_versions.sql has completed successfully.
--   - The dedicated publish RPC remains owned by postgres and is the only application write path.
--
-- Invariant:
--   postgres may INSERT immutable snapshots only through the dedicated RPC's transaction-local
--   writer guard. service_role remains read-only for this table; UPDATE/DELETE/TRUNCATE remain
--   denied and the existing ENABLE ALWAYS trigger rejects direct writes.
--
-- Lock/capacity:
--   GRANT/REVOKE changes ACL metadata only. No table rewrite, row scan, or backfill occurs.
--
-- Recovery:
--   If postflight fails, stop before releasing the Backend change. After this file commits, use a
--   reviewed forward migration to restore the prior ACL; do not edit an applied migration.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.text_postprocess_versions') IS NULL
     OR to_regprocedure('admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260929_grant_text_postprocess_snapshot_insert preflight: text-postprocess prerequisites missing';
  END IF;
  IF to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION '20260929_grant_text_postprocess_snapshot_insert preflight: service_role is missing';
  END IF;
END
$preflight$;

-- The publisher and its commit helper are SECURITY DEFINER functions owned by postgres. The
-- original migration revoked this INSERT grant from that owner, so a valid publish failed before
-- any snapshot, runtime pointer, release, or audit row could commit.
GRANT INSERT ON TABLE app_core.text_postprocess_versions TO postgres;

-- Keep the Backend's Data API role read-only even though its RPC call is allowed to reach the
-- SECURITY DEFINER publisher. Do not grant UPDATE/DELETE/TRUNCATE to postgres: snapshots remain
-- immutable and the table trigger is the second protection layer for direct writes.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE app_core.text_postprocess_versions FROM service_role;

DO $postflight$
BEGIN
  IF NOT has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'INSERT') THEN
    RAISE EXCEPTION 'postflight failed: postgres cannot insert a text-postprocess snapshot';
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
