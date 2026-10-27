-- 20261027_media_plaza_video_config.sql
-- domain: admin + app_core
-- M3: managed video model catalog and cross-media tag validation.
-- No provider model or price is seeded; operations must review and publish it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('media_plaza.video_attempts') IS NULL
     OR to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_image_plaza_tags(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'media plaza M3 prerequisites are missing';
  END IF;
  IF to_regprocedure('admin.is_managed_config_key_before_media_plaza_video(text)') IS NOT NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_media_plaza_video(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'media plaza M3 was already applied';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_image_plaza_video_model_catalog(p_value JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  v_model JSONB;
  v_other JSONB;
  v_duration JSONB;
  v_resolution JSONB;
  v_audio BOOLEAN;
  v_key TEXT;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_expected_keys TEXT[];
  v_default TEXT;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value->'models') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_value->'models') NOT BETWEEN 1 AND 30
     OR char_length(btrim(COALESCE(p_value->>'default_model_id', ''))) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'image_plaza_video_model_catalog has invalid shape' USING ERRCODE = '22023';
  END IF;
  v_default := p_value->>'default_model_id';

  FOR v_model IN SELECT value FROM jsonb_array_elements(p_value->'models') LOOP
    IF char_length(btrim(COALESCE(v_model->>'id', ''))) NOT BETWEEN 1 AND 80
       OR char_length(btrim(COALESCE(v_model->>'name', ''))) NOT BETWEEN 1 AND 80
       OR char_length(btrim(COALESCE(v_model->>'description', ''))) NOT BETWEEN 1 AND 240
       OR v_model->>'image_input' NOT IN (
         'none', 'optional_first_frame', 'optional_reference', 'required_reference'
       )
       OR jsonb_typeof(v_model->'provider_ids') IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_model->'durations') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_model->'durations') < 1
       OR jsonb_typeof(v_model->'resolutions') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_model->'resolutions') < 1
       OR jsonb_typeof(v_model->'aspect_ratios') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_model->'audio_configurable') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_model->'default_audio') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_model->'enabled') IS DISTINCT FROM 'boolean'
       OR COALESCE(v_model->>'sort_order', '') !~ '^[0-9]+$'
       OR COALESCE(v_model->>'default_duration', '') !~ '^[1-9][0-9]*$'
       OR char_length(btrim(COALESCE(v_model->>'default_resolution', ''))) NOT BETWEEN 1 AND 24
       OR jsonb_typeof(v_model->'price_matrix') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'video model has invalid shape' USING ERRCODE = '22023';
    END IF;
    IF (v_model->>'id') = ANY(v_ids) THEN
      RAISE EXCEPTION 'video model id is duplicated' USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_model->>'id');
    v_expected_keys := ARRAY[]::TEXT[];

    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_model->'durations') AS item(value)
                   WHERE item.value = v_model->>'default_duration')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_model->'resolutions') AS item(value)
                      WHERE item.value = v_model->>'default_resolution') THEN
      RAISE EXCEPTION 'video model default is outside its options' USING ERRCODE = '22023';
    END IF;

    IF (v_model->>'image_input' = 'none'
        AND (NULLIF(v_model->'provider_ids'->>'t2v', '') IS NULL
             OR v_model->'provider_ids' ? 'i2v' OR v_model->'provider_ids' ? 'r2v'))
       OR (v_model->>'image_input' = 'optional_first_frame'
        AND (NULLIF(v_model->'provider_ids'->>'t2v', '') IS NULL
             OR NULLIF(v_model->'provider_ids'->>'i2v', '') IS NULL))
       OR (v_model->>'image_input' = 'optional_reference'
        AND (NULLIF(v_model->'provider_ids'->>'t2v', '') IS NULL
             OR NULLIF(v_model->'provider_ids'->>'r2v', '') IS NULL))
       OR (v_model->>'image_input' = 'required_reference'
        AND (v_model->'provider_ids' ? 't2v'
             OR (NULLIF(v_model->'provider_ids'->>'i2v', '') IS NULL
                 AND NULLIF(v_model->'provider_ids'->>'r2v', '') IS NULL))) THEN
      RAISE EXCEPTION 'video model provider mapping is invalid' USING ERRCODE = '22023';
    END IF;

    FOR v_duration IN SELECT value FROM jsonb_array_elements(v_model->'durations') LOOP
      IF jsonb_typeof(v_duration) <> 'number' OR (v_duration#>>'{}') !~ '^[1-9][0-9]*$'
         OR (v_duration#>>'{}')::INTEGER > 300 THEN
        RAISE EXCEPTION 'video duration is invalid' USING ERRCODE = '22023';
      END IF;
      FOR v_resolution IN SELECT value FROM jsonb_array_elements(v_model->'resolutions') LOOP
        IF jsonb_typeof(v_resolution) <> 'string'
           OR char_length(btrim(v_resolution#>>'{}')) NOT BETWEEN 1 AND 24 THEN
          RAISE EXCEPTION 'video resolution is invalid' USING ERRCODE = '22023';
        END IF;
        FOR v_audio IN SELECT value
          FROM unnest(CASE WHEN (v_model->>'audio_configurable')::BOOLEAN
            THEN ARRAY[false, true] ELSE ARRAY[(v_model->>'default_audio')::BOOLEAN] END) AS option(value)
        LOOP
          v_key := (v_duration#>>'{}') || '|' || (v_resolution#>>'{}') || '|'
            || CASE WHEN v_audio THEN '1' ELSE '0' END;
          v_expected_keys := array_append(v_expected_keys, v_key);
          IF jsonb_typeof(v_model->'price_matrix'->v_key) IS DISTINCT FROM 'number'
             OR (v_model->'price_matrix'->>v_key)::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'video price matrix misses or invalidates %', v_key USING ERRCODE = '22023';
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    FOR v_key, v_other IN SELECT key, value FROM jsonb_each(v_model->'price_matrix') LOOP
      IF jsonb_typeof(v_other) <> 'number' OR (v_other#>>'{}')::NUMERIC <= 0
         OR NOT (v_key = ANY(v_expected_keys)) THEN
        RAISE EXCEPTION 'video price matrix contains invalid entry %', v_key USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_value->'models') AS model(value)
    WHERE model.value->>'id' = v_default AND model.value->>'enabled' = 'true'
  ) THEN
    RAISE EXCEPTION 'default video model must be enabled' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Keep legacy tags valid (missing media_types means image), while rejecting
-- empty, duplicated, or unknown media applicability in new configurations.
CREATE OR REPLACE FUNCTION admin.validate_image_plaza_tags(p_value JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  v_tag JSONB;
  v_media JSONB;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_media_ids TEXT[];
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR jsonb_array_length(p_value) > 80 THEN
    RAISE EXCEPTION 'image_plaza_tags has invalid shape' USING ERRCODE = '22023';
  END IF;
  FOR v_tag IN SELECT value FROM jsonb_array_elements(p_value) LOOP
    IF char_length(btrim(COALESCE(v_tag->>'id', ''))) NOT BETWEEN 1 AND 40
       OR v_tag->>'id' = 'all'
       OR char_length(btrim(COALESCE(v_tag->>'label', ''))) NOT BETWEEN 1 AND 40
       OR jsonb_typeof(v_tag->'enabled') IS DISTINCT FROM 'boolean'
       OR COALESCE(v_tag->>'sort_order', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'image plaza tag is invalid' USING ERRCODE = '22023';
    END IF;
    IF (v_tag->>'id') = ANY(v_ids) THEN
      RAISE EXCEPTION 'image plaza tag id is duplicated' USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_tag->>'id');

    v_media_ids := ARRAY[]::TEXT[];
    IF v_tag ? 'media_types' THEN
      IF jsonb_typeof(v_tag->'media_types') <> 'array'
         OR jsonb_array_length(v_tag->'media_types') NOT BETWEEN 1 AND 2 THEN
        RAISE EXCEPTION 'image plaza tag media_types is invalid' USING ERRCODE = '22023';
      END IF;
      FOR v_media IN SELECT value FROM jsonb_array_elements(v_tag->'media_types') LOOP
        IF jsonb_typeof(v_media) <> 'string' OR (v_media#>>'{}') NOT IN ('image', 'video')
           OR (v_media#>>'{}') = ANY(v_media_ids) THEN
          RAISE EXCEPTION 'image plaza tag media_types is invalid' USING ERRCODE = '22023';
        END IF;
        v_media_ids := array_append(v_media_ids, v_media#>>'{}');
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

LOCK TABLE admin.config_drafts, admin.config_releases IN ACCESS EXCLUSIVE MODE;

ALTER FUNCTION admin.is_managed_config_key(TEXT)
  RENAME TO is_managed_config_key_before_media_plaza_video;
CREATE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT p_config_key = 'image_plaza_video_model_catalog'
    OR admin.is_managed_config_key_before_media_plaza_video(p_config_key)
$$;

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_media_plaza_video;
CREATE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT, p_value JSONB, p_text_value TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_config_key = 'image_plaza_video_model_catalog' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_plaza_video_model_catalog(p_value);
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_media_plaza_video(
    p_config_key, p_value, p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_image_plaza_video_model_catalog(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key_before_media_plaza_video(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_media_plaza_video(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $widen_checks$
DECLARE
  v_table REGCLASS;
  v_name TEXT;
  v_expression TEXT;
  v_validated BOOLEAN;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::REGCLASS, 'admin.config_releases'::REGCLASS
  ] LOOP
    v_name := CASE v_table
      WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid), constraint_row.convalidated
      INTO v_expression, v_validated
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_table
      AND constraint_row.conname = v_name
      AND constraint_row.contype = 'c';
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'media plaza M3 missing constraint %.%', v_table, v_name;
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
      v_table, v_name, v_expression, CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
    );
  END LOOP;
END
$widen_checks$;

DO $$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  IF admin.is_managed_config_key('image_plaza_video_model_catalog') IS DISTINCT FROM true
     OR admin.is_managed_config_key('__unknown_config_key__') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'media plaza M3 managed-key self-check failed';
  END IF;
  PERFORM admin.validate_image_plaza_tags(
    '[{"id":"motion","label":"Motion","enabled":true,"sort_order":0,"media_types":["video"]}]'::JSONB
  );
  BEGIN
    PERFORM admin.validate_image_plaza_tags(
      '[{"id":"bad","label":"Bad","enabled":true,"sort_order":0,"media_types":[]}]'::JSONB
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'media plaza M3 invalid tag self-check was accepted';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
