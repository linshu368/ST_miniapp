-- domain: admin
-- Accept the fixed rich-reply protocol descriptor in compiled text-postprocess artifacts.
--
-- Preconditions:
--   - 20260928_text_postprocess_versions.sql has completed successfully.
--   - Backend/Shared compiler emits rich_reply_protocol with version 1 or 2.
--
-- Scope:
--   Replaces only the publish/rollback artifact-shape validator. It does not modify
--   runtime_config, drafts, releases, immutable snapshots, RLS, or grants.
--
-- Lock/capacity:
--   CREATE OR REPLACE FUNCTION takes only routine metadata locks. No table rewrite,
--   row scan, or backfill occurs. Execute as one file through Database Migration.
--
-- Release order:
--   Apply to TEST before publishing a rule compiled by the rich-reply-protocol-aware
--   Backend. Production requires a separate approval and the same order.
--
-- Recovery:
--   Use a reviewed forward-fix to replace this function body if a later protocol
--   revision changes the artifact contract. Do not rewrite historical snapshots.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.validate_text_postprocess_artifact(jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'missing admin.validate_text_postprocess_artifact(jsonb,jsonb)';
  END IF;
END;
$preflight$;

-- SQL validates the durable protocol descriptor and source binding only. The Backend
-- remains responsible for compiling HTML, CSS, and regular expressions in its worker.
CREATE OR REPLACE FUNCTION admin.validate_text_postprocess_artifact(p_source jsonb, p_artifact jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_source_rule jsonb;
  v_rule jsonb;
  v_protocol jsonb;
  v_index integer;
BEGIN
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) IS DISTINCT FROM 'object'
    OR p_artifact -> 'schema_version' IS DISTINCT FROM p_source -> 'schema_version'
    OR p_artifact -> 'policy_version' IS DISTINCT FROM p_source -> 'policy_version'
    OR jsonb_typeof(p_artifact -> 'rich_reply_protocol') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_artifact -> 'rules') IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_artifact) AS key
      WHERE key NOT IN ('schema_version', 'policy_version', 'rich_reply_protocol', 'rules')
    ) THEN
    RAISE EXCEPTION 'invalid_source: compiled artifact is required' USING ERRCODE = '22023';
  END IF;

  v_protocol := p_artifact -> 'rich_reply_protocol';
  IF jsonb_typeof(v_protocol -> 'version') IS DISTINCT FROM 'number'
    OR (v_protocol ->> 'version') NOT IN ('1', '2')
    OR jsonb_typeof(v_protocol -> 'enabled') IS DISTINCT FROM 'boolean'
    OR EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_protocol) AS key
      WHERE key NOT IN ('version', 'enabled')
    ) THEN
    RAISE EXCEPTION 'invalid_source: rich reply protocol is invalid' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_artifact -> 'rules') <> jsonb_array_length(p_source -> 'rules') THEN
    RAISE EXCEPTION 'invalid_source: artifact source rule count mismatch' USING ERRCODE = '22023';
  END IF;
  FOR v_index IN 0..jsonb_array_length(p_source -> 'rules') - 1 LOOP
    v_source_rule := p_source -> 'rules' -> v_index;
    v_rule := p_artifact -> 'rules' -> v_index;
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object'
      OR v_rule -> 'id' IS DISTINCT FROM v_source_rule -> 'id'
      OR v_rule -> 'enabled' IS DISTINCT FROM v_source_rule -> 'enabled'
      OR v_rule -> 'pattern' IS DISTINCT FROM v_source_rule -> 'pattern'
      OR v_rule -> 'flags' IS DISTINCT FROM v_source_rule -> 'flags'
      OR jsonb_typeof(v_rule -> 'groups') IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_rule -> 'tree') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_rule -> 'tree') < 1
      OR jsonb_typeof(v_rule -> 'css') IS DISTINCT FROM 'array'
      OR COALESCE(v_rule ->> 'placement', '') NOT IN ('inline', 'block') THEN
      RAISE EXCEPTION 'invalid_source: artifact source binding mismatch' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$fn$;

-- Contract checks are deliberately migration-local: they prove the new descriptor
-- is accepted and malformed descriptors still fail before any snapshot write.
DO $verify$
DECLARE
  v_source jsonb := jsonb_build_object(
    'schema_version', 1,
    'policy_version', 1,
    'rules', '[]'::jsonb
  );
  v_artifact jsonb := jsonb_build_object(
    'schema_version', 1,
    'policy_version', 1,
    'rich_reply_protocol', jsonb_build_object('version', 2, 'enabled', true),
    'rules', '[]'::jsonb
  );
  v_rejected boolean := false;
BEGIN
  PERFORM admin.validate_text_postprocess_artifact(v_source, v_artifact);

  BEGIN
    PERFORM admin.validate_text_postprocess_artifact(
      v_source,
      jsonb_set(v_artifact, '{rich_reply_protocol,version}', '3'::jsonb)
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'self-check failed: unsupported rich reply protocol was accepted';
  END IF;
END;
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
