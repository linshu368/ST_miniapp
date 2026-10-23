-- migration-domain: admin
-- Extend existing Admin configuration validators; no new objects/tables/grants.
-- Prerequisites: 20260928_text_postprocess_versions.sql and
-- 20261013_accept_rich_reply_protocol_artifact.sql; fail rather than creating missing validators.
-- Deploy: apply this file in TEST, deploy all consumers, then publish recovery config.
-- Production requires independent migration/config publication approval.
-- Recovery: publish an older source without rich_reply before rolling application code back.
-- Retain this additive validator expansion; never rewrite immutable snapshots.
-- Locks/capacity: catalog replacement only, no table scan/backfill; 5s lock / 30s statement budgets.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
  IF to_regprocedure('admin.validate_text_postprocess_source(jsonb,text)') IS NULL
    OR to_regprocedure('admin.validate_text_postprocess_artifact(jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'missing text postprocess validator prerequisites';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION admin.validate_text_postprocess_source(
  p_source jsonb,
  p_mode text
) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_rule jsonb;
  v_recovery jsonb;
  v_card jsonb;
  v_pair jsonb;
  v_alias jsonb;
  v_aliases text[] := ARRAY['choices', 'choice', 'status', 'memory'];
  v_tag text;
  v_key text;
  v_id text;
  v_flags text;
  v_seen text[] := ARRAY[]::text[];
  v_flag_index integer;
  v_schema integer;
  v_policy integer;
  v_prefix text;
BEGIN
  IF p_mode NOT IN ('draft', 'publish', 'rollback') THEN
    RAISE EXCEPTION 'invalid_source: unsupported validation mode'
      USING ERRCODE = '22023';
  END IF;
  v_prefix := CASE WHEN p_mode = 'draft' THEN 'invalid_draft' ELSE 'invalid_source' END;

  IF p_source IS NULL OR jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION '%: source must be an object', v_prefix USING ERRCODE = '22023';
  END IF;
  IF octet_length(convert_to(p_source::text, 'UTF8')) > 262144 THEN
    RAISE EXCEPTION '%: source exceeds 256 KiB', v_prefix USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_source) AS key
    WHERE key NOT IN ('schema_version', 'policy_version', 'rich_reply', 'rules')
  ) THEN
    RAISE EXCEPTION '%: unknown source field', v_prefix USING ERRCODE = '22023';
  END IF;
  IF (p_source ->> 'schema_version') !~ '^[0-9]+$'
     OR (p_source ->> 'policy_version') !~ '^[0-9]+$'
     OR jsonb_typeof(p_source -> 'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '%: source shape is invalid', v_prefix USING ERRCODE = '22023';
  END IF;

  v_schema := (p_source ->> 'schema_version')::integer;
  v_policy := (p_source ->> 'policy_version')::integer;
  IF v_schema <> 1 THEN
    RAISE EXCEPTION '%: unsupported schema_version', v_prefix USING ERRCODE = '22023';
  END IF;
  IF v_policy <> 1 THEN
    IF p_mode = 'rollback' THEN
      RAISE EXCEPTION 'policy_unsupported: snapshot policy_version is not supported'
        USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION '%: unsupported policy_version', v_prefix USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_source -> 'rules') > 100 THEN
    RAISE EXCEPTION '%: too many rules', v_prefix USING ERRCODE = '22023';
  END IF;

  IF p_source ? 'rich_reply' THEN
    v_recovery := p_source -> 'rich_reply';
    IF jsonb_typeof(v_recovery) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION '%: recovery must be an object', v_prefix USING ERRCODE = '22023';
    END IF;
    IF NOT (v_recovery ?& ARRAY['unwrap_code_fences','bracket_pairs','tag_aliases','choices','status','memory'])
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_recovery) AS key
        WHERE key NOT IN ('unwrap_code_fences','bracket_pairs','tag_aliases','choices','status','memory'))
      OR jsonb_typeof(v_recovery -> 'unwrap_code_fences') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_recovery -> 'bracket_pairs') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_recovery -> 'tag_aliases') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION '%: recovery fields are invalid', v_prefix USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_recovery -> 'bracket_pairs') > 8 THEN
      RAISE EXCEPTION '%: too many bracket pairs', v_prefix USING ERRCODE = '22023';
    END IF;
    FOR v_pair IN SELECT value FROM jsonb_array_elements(v_recovery -> 'bracket_pairs') LOOP
      IF jsonb_typeof(v_pair) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION '%: invalid bracket pair', v_prefix USING ERRCODE = '22023';
      END IF;
      IF NOT (v_pair ?& ARRAY['open','close'])
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_pair) AS key WHERE key NOT IN ('open','close')) THEN
        RAISE EXCEPTION '%: invalid bracket fields', v_prefix USING ERRCODE = '22023';
      END IF;
      FOREACH v_tag IN ARRAY ARRAY['open','close'] LOOP
        IF jsonb_typeof(v_pair -> v_tag) IS DISTINCT FROM 'string'
          OR char_length(v_pair ->> v_tag) NOT BETWEEN 1 AND 4
          OR (v_pair ->> v_tag) ~ '[[:alnum:][:space:]/`~<>]' THEN
          RAISE EXCEPTION '%: invalid bracket', v_prefix USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_tag IN ARRAY ARRAY['choices','status','memory'] LOOP
      v_card := v_recovery -> v_tag;
      IF jsonb_typeof(v_card) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION '%: invalid recovery card', v_prefix USING ERRCODE = '22023';
      END IF;
      IF NOT (v_card ?& ARRAY['recover_at_eof','title','subtitle','fallback_title','fallback_subtitle'])
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_card) AS key
          WHERE key NOT IN ('recover_at_eof','title','subtitle','fallback_title','fallback_subtitle'))
        OR jsonb_typeof(v_card -> 'recover_at_eof') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION '%: invalid recovery card fields', v_prefix USING ERRCODE = '22023';
      END IF;
      FOREACH v_key IN ARRAY ARRAY['title','subtitle','fallback_title','fallback_subtitle'] LOOP
        IF jsonb_typeof(v_card -> v_key) IS DISTINCT FROM 'string'
          OR char_length(v_card ->> v_key) > (CASE WHEN v_key IN ('title','fallback_title') THEN 80 ELSE 160 END) THEN
          RAISE EXCEPTION '%: invalid recovery card text', v_prefix USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END LOOP;
    IF NOT ((v_recovery -> 'tag_aliases') ?& ARRAY['choices','choice','status','memory'])
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_recovery -> 'tag_aliases') AS key
        WHERE key NOT IN ('choices','choice','status','memory')) THEN
      RAISE EXCEPTION '%: invalid alias fields', v_prefix USING ERRCODE = '22023';
    END IF;
    FOREACH v_tag IN ARRAY ARRAY['choices','choice','status','memory'] LOOP
      IF jsonb_typeof(v_recovery -> 'tag_aliases' -> v_tag) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION '%: aliases must be arrays', v_prefix USING ERRCODE = '22023';
      END IF;
      IF jsonb_array_length(v_recovery -> 'tag_aliases' -> v_tag) > 8 THEN
        RAISE EXCEPTION '%: too many aliases', v_prefix USING ERRCODE = '22023';
      END IF;
      -- Unicode tag grammar is validated by Shared, independent of database locale.
      FOR v_alias IN SELECT value FROM jsonb_array_elements(v_recovery -> 'tag_aliases' -> v_tag) LOOP
        IF jsonb_typeof(v_alias) IS DISTINCT FROM 'string'
          OR char_length(v_alias #>> '{}') NOT BETWEEN 1 AND 32
          OR lower(v_alias #>> '{}') = ANY(v_aliases) THEN
          RAISE EXCEPTION '%: invalid or duplicate alias', v_prefix USING ERRCODE = '22023';
        END IF;
        v_aliases := array_append(v_aliases, lower(v_alias #>> '{}'));
      END LOOP;
    END LOOP;
  END IF;

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(p_source -> 'rules') AS rule(value)
  LOOP
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION '%: rule must be an object', v_prefix USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_rule) AS key
      WHERE key NOT IN (
        'id', 'name', 'description', 'enabled', 'pattern', 'flags', 'replacement', 'css', 'notes'
      )
    ) OR NOT (
      v_rule ? 'id' AND v_rule ? 'name' AND v_rule ? 'description' AND v_rule ? 'enabled'
      AND v_rule ? 'pattern' AND v_rule ? 'flags' AND v_rule ? 'replacement'
      AND v_rule ? 'css' AND v_rule ? 'notes'
    ) THEN
      RAISE EXCEPTION '%: rule fields are invalid', v_prefix USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_rule -> 'enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_rule -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'pattern') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'flags') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'replacement') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'css') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'notes') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION '%: rule field types are invalid', v_prefix USING ERRCODE = '22023';
    END IF;

    v_id := v_rule ->> 'id';
    IF v_id !~ '^[a-z][a-z0-9_-]{0,63}$' OR v_id = ANY (v_seen) THEN
      RAISE EXCEPTION '%: rule id is invalid or duplicated', v_prefix USING ERRCODE = '22023';
    END IF;
    v_seen := array_append(v_seen, v_id);

    IF char_length(v_rule ->> 'name') NOT BETWEEN 1 AND 80
       OR btrim(v_rule ->> 'name') = ''
       OR char_length(v_rule ->> 'description') > 400
       OR char_length(v_rule ->> 'pattern') NOT BETWEEN 1 AND 2000
       OR char_length(v_rule ->> 'flags') > 8
       OR char_length(v_rule ->> 'replacement') > 16000
       OR char_length(v_rule ->> 'css') > 16000
       OR char_length(v_rule ->> 'notes') > 2000 THEN
      RAISE EXCEPTION '%: rule field length is invalid', v_prefix USING ERRCODE = '22023';
    END IF;

    IF p_mode IN ('publish', 'rollback') THEN
      v_flags := v_rule ->> 'flags';
      IF v_flags !~ '^[gimsu]*$' THEN
        RAISE EXCEPTION '%: flags are not supported', v_prefix USING ERRCODE = '22023';
      END IF;
      FOR v_flag_index IN 1..char_length(v_flags) LOOP
        v_key := substr(v_flags, v_flag_index, 1);
        IF strpos(left(v_flags, v_flag_index - 1), v_key) > 0 THEN
          RAISE EXCEPTION '%: flags are duplicated', v_prefix USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$fn$;

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

  PERFORM admin.validate_text_postprocess_source(p_source, 'publish');
  v_protocol := p_artifact -> 'rich_reply_protocol';
  IF jsonb_typeof(v_protocol -> 'version') IS DISTINCT FROM 'number'
    OR (v_protocol ->> 'version') NOT IN ('1', '2', '3')
    OR jsonb_typeof(v_protocol -> 'enabled') IS DISTINCT FROM 'boolean'
    OR EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_protocol) AS key
      WHERE key NOT IN ('version', 'enabled', 'recovery')
    ) THEN
    RAISE EXCEPTION 'invalid_source: rich reply protocol is invalid' USING ERRCODE = '22023';
  END IF;

  -- Bind recovery to the saved source, including absence. Old snapshots remain valid.
  IF (v_protocol -> 'recovery') IS DISTINCT FROM (p_source -> 'rich_reply')
    OR ((v_protocol ->> 'version' = '3') IS DISTINCT FROM (p_source ? 'rich_reply')) THEN
    RAISE EXCEPTION 'invalid_source: recovery source binding mismatch' USING ERRCODE = '22023';
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

REVOKE ALL ON FUNCTION admin.validate_text_postprocess_source(jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_text_postprocess_artifact(jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
