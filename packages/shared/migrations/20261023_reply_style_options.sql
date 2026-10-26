-- domain: app_core / admin
-- app_core owns long-lived user preference maps and the formal UI catalog;
-- admin owns draft/release validation. Operator marker/rules are stored only:
-- this migration does not inject or execute them and seeds no option content.
--
-- TEST first; then Backend/Admin; then Frontend. Production is a separate gate.
-- Constant JSONB default needs no application backfill. CHECK validation can
-- scan existing settings/Admin history; use low traffic and stop on lock timeout.
-- Idempotent: retain operator values, prior managed keys, CHECK expressions,
-- validation state, owners and effective wrapper ACLs. No history is rewritten.
-- Recovery: rollback/disable the published catalog, retain additive objects and
-- audit history; fix database defects with a reviewed forward migration.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.miniapp_user_settings') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL
     OR to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'reply style options: prerequisite objects missing';
  END IF;
  IF (to_regprocedure('admin.is_managed_config_key_before_reply_styles(text)') IS NULL)
     <> (to_regprocedure('admin.validate_managed_config_value_before_reply_styles(text,jsonb,text)') IS NULL) THEN
    RAISE EXCEPTION 'reply style options: inconsistent wrapper predecessor state';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'admin.is_managed_config_key(text)'::regprocedure
      AND p.prorettype = 'boolean'::regtype AND NOT p.proretset
      AND NOT p.prosecdef AND p.provolatile = 'i' AND p.proparallel = 's'
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure
      AND p.prorettype = 'void'::regtype AND NOT p.proretset
      AND NOT p.prosecdef AND p.provolatile = 's'
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'reply style options: unexpected managed-config function shape/owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid IN (
      to_regprocedure('app_core.is_valid_reply_style_preferences(jsonb)'),
      to_regprocedure('app_core.update_reply_style_preferences(uuid,jsonb)')
    ) AND (p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user) OR p.prosecdef)
  ) THEN
    RAISE EXCEPTION 'reply style options: unexpected preference function owner/security';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION app_core.is_valid_reply_style_preferences(p_value JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
  SELECT CASE WHEN jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN false
    ELSE (
      SELECT count(*) <= 64 AND coalesce(bool_and(
        key ~ '^style-[a-z0-9][a-z0-9-]{0,58}$' AND jsonb_typeof(value) = 'boolean'
      ), true)
      FROM jsonb_each(p_value)
    )
  END
$fn$;

REVOKE ALL ON FUNCTION app_core.is_valid_reply_style_preferences(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_core.is_valid_reply_style_preferences(JSONB) TO service_role;

ALTER TABLE app_core.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS pref_reply_styles JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $preference_shape$
DECLARE
  v_expression TEXT;
  v_allowed BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'app_core.miniapp_user_settings'::regclass
      AND a.attname = 'pref_reply_styles' AND NOT a.attisdropped
      AND a.atttypid = 'jsonb'::regtype AND a.attnotnull
      AND pg_get_expr(d.adbin, d.adrelid) = '''{}''::jsonb'
  ) THEN
    RAISE EXCEPTION 'reply style options: unexpected preference column shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname = 'miniapp_user_settings_pref_reply_styles_check'
  ) THEN
    ALTER TABLE app_core.miniapp_user_settings
      ADD CONSTRAINT miniapp_user_settings_pref_reply_styles_check
      CHECK (app_core.is_valid_reply_style_preferences(pref_reply_styles));
  END IF;
  SELECT pg_get_expr(conbin, conrelid) INTO v_expression
  FROM pg_constraint
  WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
    AND conname = 'miniapp_user_settings_pref_reply_styles_check'
    AND contype = 'c' AND convalidated;
  IF v_expression IS NULL THEN
    RAISE EXCEPTION 'reply style options: preference CHECK missing or unvalidated';
  END IF;
  EXECUTE format('SELECT (%s) FROM (SELECT $1::jsonb AS pref_reply_styles) AS candidate', v_expression)
    INTO v_allowed USING '[]';
  IF v_allowed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'reply style options: preference CHECK accepts non-object';
  END IF;
END
$preference_shape$;

CREATE OR REPLACE FUNCTION app_core.update_reply_style_preferences(
  p_user_id UUID, p_patch JSONB
) RETURNS VOID LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $fn$
BEGIN
  IF p_user_id IS NULL OR NOT app_core.is_valid_reply_style_preferences(p_patch) THEN
    RAISE EXCEPTION 'reply style preferences must be an object of at most 64 valid boolean options'
      USING ERRCODE = '22023';
  END IF;
  -- ON CONFLICT locks the current user row before merging. Independent option
  -- writes cannot overwrite each other with a stale read-modify-write snapshot.
  -- The table CHECK also bounds the merged result, preserving the old map on error.
  INSERT INTO app_core.miniapp_user_settings(user_id, pref_reply_styles, updated_at)
  VALUES (p_user_id, p_patch, now())
  ON CONFLICT (user_id) DO UPDATE SET
    pref_reply_styles = app_core.miniapp_user_settings.pref_reply_styles || EXCLUDED.pref_reply_styles,
    updated_at = now();
END;
$fn$;

REVOKE ALL ON FUNCTION app_core.update_reply_style_preferences(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_core.update_reply_style_preferences(UUID, JSONB) TO service_role;

LOCK TABLE admin.config_drafts, admin.config_releases IN ACCESS EXCLUSIVE MODE;

DO $extend_functions$
DECLARE
  v_signature TEXT;
  v_predecessor TEXT;
  v_original_acl ACLITEM[];
  v_acl RECORD;
  v_role TEXT;
  v_new_functions TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF to_regprocedure('admin.is_managed_config_key_before_reply_styles(text)') IS NULL THEN
    ALTER FUNCTION admin.is_managed_config_key(TEXT)
      RENAME TO is_managed_config_key_before_reply_styles;
    EXECUTE $ddl$
      CREATE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
      RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
      AS $body$
        SELECT p_config_key = 'reply_style_options'
          OR admin.is_managed_config_key_before_reply_styles(p_config_key)
      $body$
    $ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.is_managed_config_key(text)');
  END IF;

  IF to_regprocedure('admin.validate_managed_config_value_before_reply_styles(text,jsonb,text)') IS NULL THEN
    ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
      RENAME TO validate_managed_config_value_before_reply_styles;
    EXECUTE $ddl$
      CREATE FUNCTION admin.validate_managed_config_value(
        p_config_key TEXT, p_value JSONB, p_text_value TEXT DEFAULT NULL
      ) RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = pg_catalog
      AS $body$
      DECLARE
        v_option JSONB;
        v_field TEXT;
        v_text TEXT;
        v_length BIGINT;
        v_limit INTEGER;
        v_ids TEXT[] := ARRAY[]::TEXT[];
        v_markers TEXT[] := ARRAY[]::TEXT[];
      BEGIN
        IF p_config_key = 'reply_style_options' THEN
          IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'reply_style_options must use JSON value only' USING ERRCODE = '22023';
          END IF;
          IF (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 1
             OR jsonb_typeof(p_value -> 'options') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'reply_style_options must contain only an options array' USING ERRCODE = '22023';
          END IF;
          IF jsonb_array_length(p_value -> 'options') > 24 THEN
            RAISE EXCEPTION 'reply_style_options allows at most 24 options' USING ERRCODE = '22023';
          END IF;
          FOR v_option IN SELECT jsonb_array_elements(p_value -> 'options') LOOP
            IF jsonb_typeof(v_option) IS DISTINCT FROM 'object' THEN
              RAISE EXCEPTION 'reply style option must be an object' USING ERRCODE = '22023';
            END IF;
            IF (SELECT count(*) FROM jsonb_object_keys(v_option)) <> 6
               OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_option) AS key
                 WHERE key NOT IN ('id', 'name', 'description', 'marker', 'rules', 'enabled'))
               OR jsonb_typeof(v_option -> 'id') IS DISTINCT FROM 'string'
               OR (v_option ->> 'id') !~ '^style-[a-z0-9][a-z0-9-]{0,58}$'
               OR jsonb_typeof(v_option -> 'enabled') IS DISTINCT FROM 'boolean' THEN
              RAISE EXCEPTION 'reply style option has invalid fields or identity' USING ERRCODE = '22023';
            END IF;
            IF (v_option ->> 'id') = ANY(v_ids) THEN
              RAISE EXCEPTION 'reply style option identities must be unique' USING ERRCODE = '22023';
            END IF;
            v_ids := array_append(v_ids, v_option ->> 'id');
            FOREACH v_field IN ARRAY ARRAY['name', 'description', 'marker', 'rules'] LOOP
              IF jsonb_typeof(v_option -> v_field) IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION 'reply style text fields must be strings' USING ERRCODE = '22023';
              END IF;
              -- Match ECMAScript TrimString, including NBSP and pasted byte-order marks.
              v_text := btrim(v_option ->> v_field, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
              -- Match JavaScript/Zod's UTF-16 length even for supplementary characters.
              SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
                INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
              v_limit := CASE v_field WHEN 'name' THEN 40 WHEN 'description' THEN 200
                WHEN 'marker' THEN 120 ELSE 12000 END;
              IF v_length > v_limit OR (v_field = 'name' AND v_length = 0) THEN
                RAISE EXCEPTION 'reply style text field exceeds its bounds' USING ERRCODE = '22023';
              END IF;
              IF v_field = 'marker' AND v_text <> '' THEN
                IF v_text = ANY(v_markers) THEN
                  RAISE EXCEPTION 'nonempty reply style markers must be unique' USING ERRCODE = '22023';
                END IF;
                v_markers := array_append(v_markers, v_text);
              END IF;
            END LOOP;
          END LOOP;
          RETURN;
        END IF;
        PERFORM admin.validate_managed_config_value_before_reply_styles(
          p_config_key, p_value, p_text_value
        );
      END;
      $body$
    $ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.validate_managed_config_value(text,jsonb,text)');
  END IF;

  -- Old OIDs remain intact after rename; copy effective EXECUTE privileges to
  -- the wrappers, including custom roles and grant options, rather than adding
  -- the default PUBLIC grant or narrowing permissions maintained by operators.
  FOREACH v_signature IN ARRAY v_new_functions LOOP
    v_predecessor := CASE v_signature
      WHEN 'admin.is_managed_config_key(text)'
        THEN 'admin.is_managed_config_key_before_reply_styles(text)'
      ELSE 'admin.validate_managed_config_value_before_reply_styles(text,jsonb,text)'
    END;
    SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_original_acl
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_predecessor);
    FOR v_acl IN
      SELECT DISTINCT acl.grantee
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.oid = to_regprocedure(v_signature)
    LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_signature, v_role);
    END LOOP;
    FOR v_acl IN SELECT * FROM aclexplode(v_original_acl) LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', v_signature, v_role,
        CASE WHEN v_acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END
$extend_functions$;

DO $widen_checks$
DECLARE
  v_table REGCLASS;
  v_name TEXT;
  v_expression TEXT;
  v_validated BOOLEAN;
  v_allowed BOOLEAN;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::regclass, 'admin.config_releases'::regclass
  ] LOOP
    v_name := CASE v_table
      WHEN 'admin.config_drafts'::regclass THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_expr(c.conbin, c.conrelid), c.convalidated
      INTO v_expression, v_validated
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'reply style options: missing constraint %.%', v_table, v_name;
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING 'reply_style_options';
    IF v_allowed IS DISTINCT FROM true THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
        v_table, v_name, v_expression,
        CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
      );
    END IF;
    SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_expression
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c'
      AND c.convalidated = v_validated;
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'reply style options: constraint validation state changed';
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING 'reply_style_options';
    IF v_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'reply style options: new key rejected by %', v_table;
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING '__unknown_config_key__';
    IF v_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'reply style options: unknown key accepted by %', v_table;
    END IF;
  END LOOP;
END
$widen_checks$;

INSERT INTO app_core.runtime_config(key, value, text_value, description, version, updated_at)
VALUES ('reply_style_options', '{"options": []}'::jsonb, NULL,
  '回复风格选项：运营自行维护用户界面字段，marker/rules仅存储、不注入。', 1, now())
ON CONFLICT (key) DO NOTHING;

DO $selfcheck$
DECLARE
  v_key TEXT;
  v_rejected BOOLEAN := false;
BEGIN
  IF NOT admin.is_managed_config_key('reply_style_options')
     OR NOT app_core.is_valid_reply_style_preferences('{}'::jsonb)
     OR app_core.is_valid_reply_style_preferences('[]'::jsonb)
     OR app_core.is_valid_reply_style_preferences('{"style-invalid": "true"}'::jsonb) THEN
    RAISE EXCEPTION 'reply style options: shape self-check failed';
  END IF;
  FOREACH v_key IN ARRAY ARRAY[
    'system_instructions', 'choice_rules', 'status_rules', 'memory_rules',
    'llm_model_catalog', 'image_plaza_enabled', 'image_plaza_model_catalog',
    'image_plaza_share_tip', 'image_plaza_tags', 'image_plaza_tags_feature_enabled',
    'miniapp_text_postprocess_config', 'interaction_mode_blocks', '__unknown_config_key__'
  ] LOOP
    IF admin.is_managed_config_key(v_key) IS DISTINCT FROM
       admin.is_managed_config_key_before_reply_styles(v_key) THEN
      RAISE EXCEPTION 'reply style options: unrelated key behavior changed: %', v_key;
    END IF;
  END LOOP;
  PERFORM admin.validate_managed_config_value('reply_style_options', '{"options": []}'::jsonb, NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value('reply_style_options', '{"options": [null]}'::jsonb, NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'reply style options: invalid option accepted'; END IF;
END
$selfcheck$;

NOTIFY pgrst, 'reload schema';
COMMIT;
