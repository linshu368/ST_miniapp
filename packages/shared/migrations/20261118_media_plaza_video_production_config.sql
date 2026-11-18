-- domain: admin
-- Production registry/FK adapter for the existing video catalog contract.
-- One-shot and atomic. No model, price, runtime-config value or release is published.
-- Unknown commit: inspect catalog + claim + ledger before recovery; do not force reruns.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_table REGCLASS;
  v_key_column SMALLINT;
  v_registry_column SMALLINT;
BEGIN
  IF to_regclass('media_plaza.video_attempts') IS NULL
     OR to_regclass('admin.managed_config_keys') IS NULL
     OR to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_image_plaza_tags(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'video_prod_config: registry prerequisites missing';
  END IF;
  IF to_regprocedure('admin.validate_image_plaza_video_model_catalog(jsonb)') IS NOT NULL
     OR to_regprocedure('admin.is_managed_config_key_before_media_plaza_video(text)') IS NOT NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_media_plaza_video(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'video_prod_config: already or partially provisioned';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid='admin.is_managed_config_key(text)'::regprocedure
    AND provolatile='s' AND proconfig=ARRAY['search_path=pg_catalog']
    AND strpos(prosrc,'admin.managed_config_keys')>0) THEN
    RAISE EXCEPTION 'video_prod_config: managed-key lookup differs';
  END IF;
  SELECT attnum INTO v_registry_column FROM pg_attribute
    WHERE attrelid='admin.managed_config_keys'::regclass AND attname='config_key' AND NOT attisdropped;
  FOREACH v_table IN ARRAY ARRAY['admin.config_drafts'::regclass,'admin.config_releases'::regclass] LOOP
    SELECT attnum INTO v_key_column FROM pg_attribute
      WHERE attrelid=v_table AND attname='config_key' AND NOT attisdropped;
    IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid=v_table AND contype='f'
      AND confrelid='admin.managed_config_keys'::regclass AND conkey=ARRAY[v_key_column]
      AND confkey=ARRAY[v_registry_column] AND convalidated)
      OR EXISTS (SELECT FROM pg_constraint WHERE conrelid=v_table
        AND conname IN ('config_drafts_config_key_check','config_releases_config_key_check')) THEN
      RAISE EXCEPTION 'video_prod_config: config-key foreign keys differ';
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM admin.managed_config_keys
    WHERE config_key='image_plaza_video_model_catalog'
      AND (managed_via IS DISTINCT FROM 'operations_config' OR retired_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'video_prod_config: video key registration conflicts';
  END IF;
END;
$preflight$;

-- Catalog-only snapshots prevent accidental changes to unrelated lookup/validator/FK contracts.
CREATE TEMP TABLE video_prod_config_functions ON COMMIT DROP AS
SELECT p.oid, to_jsonb(p)-'prosrc'-'proargdefaults'-'prosqlbody' AS attributes, p.prosrc
FROM pg_proc p WHERE p.oid IN ('admin.is_managed_config_key(text)'::regprocedure,
  'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure,
  'admin.validate_image_plaza_tags(jsonb)'::regprocedure);
CREATE TEMP TABLE video_prod_config_constraints ON COMMIT DROP AS
SELECT oid,to_jsonb(c) AS definition FROM pg_constraint c
WHERE conrelid IN ('admin.config_drafts'::regclass,'admin.config_releases'::regclass);
CREATE TEMP TABLE video_prod_config_keys ON COMMIT DROP AS
SELECT config_key,admin.is_managed_config_key(config_key) AS editable FROM admin.managed_config_keys
UNION ALL SELECT NULL::TEXT,admin.is_managed_config_key(NULL)
UNION ALL SELECT '__video_prod_unknown_key__',admin.is_managed_config_key('__video_prod_unknown_key__');

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
       OR COALESCE(v_model->>'image_input', '') NOT IN (
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
            RAISE EXCEPTION 'video price matrix has a missing or invalid entry' USING ERRCODE = '22023';
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    FOR v_key, v_other IN SELECT key, value FROM jsonb_each(v_model->'price_matrix') LOOP
      IF jsonb_typeof(v_other) <> 'number' OR (v_other#>>'{}')::NUMERIC <= 0
         OR NOT (v_key = ANY(v_expected_keys)) THEN
        RAISE EXCEPTION 'video price matrix contains an invalid entry' USING ERRCODE = '22023';
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

REVOKE ALL ON FUNCTION admin.validate_image_plaza_video_model_catalog(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION admin.validate_image_plaza_video_model_catalog(JSONB) IS
  'Internal video catalog validator; publication and prices still use the managed-config workflow.';

INSERT INTO admin.managed_config_keys(config_key,managed_via,note)
VALUES('image_plaza_video_model_catalog','operations_config','Video model catalog; publish reviewed provider mappings and pricing through the operations CLI.')
ON CONFLICT(config_key) DO NOTHING;

-- Add a single branch to the current outer validator, preserving its existing delegation/body.
DO $extend$
DECLARE
  v_oid OID := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_body TEXT;
  v_definition TEXT;
  v_expected TEXT;
  v_pos INTEGER;
  v_branch CONSTANT TEXT := $branch$
  IF p_config_key = 'image_plaza_video_model_catalog' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'video catalog must not use text_value' USING ERRCODE='22023';
    END IF;
    PERFORM admin.validate_image_plaza_video_model_catalog(p_value);
    RETURN;
  END IF;
$branch$;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE oid=v_oid;
  IF v_body !~ '^[[:space:]]*BEGIN[[:space:]]'
     OR strpos(v_body,'image_plaza_video_model_catalog')>0 THEN
    RAISE EXCEPTION 'video_prod_config: unknown validator body';
  END IF;
  v_definition := pg_get_functiondef(v_oid);
  IF length(v_definition)-length(replace(v_definition,v_body,''))<>length(v_body) THEN
    RAISE EXCEPTION 'video_prod_config: ambiguous validator source';
  END IF;
  v_pos := strpos(v_body,'BEGIN')+length('BEGIN');
  v_expected := substr(v_body,1,v_pos-1)||v_branch||substr(v_body,v_pos);
  EXECUTE replace(v_definition,v_body,v_expected);
  IF (SELECT prosrc FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'video_prod_config: validator branch installation failed';
  END IF;
END;
$extend$;

DO $postflight$
DECLARE v_outer OID := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
BEGIN
  IF NOT admin.is_managed_config_key('image_plaza_video_model_catalog')
     OR admin.is_managed_config_key(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'video_prod_config: key lookup postflight failed';
  END IF;
  IF EXISTS (SELECT FROM pg_temp.video_prod_config_functions b LEFT JOIN pg_proc p ON p.oid=b.oid
    WHERE p.oid IS NULL OR (to_jsonb(p)-'prosrc'-'proargdefaults'-'prosqlbody') IS DISTINCT FROM b.attributes
      OR (b.oid<>v_outer AND p.prosrc IS DISTINCT FROM b.prosrc)) THEN
    RAISE EXCEPTION 'video_prod_config: function identity or attributes changed';
  END IF;
  IF EXISTS (SELECT FROM pg_temp.video_prod_config_constraints b FULL JOIN
    (SELECT oid,to_jsonb(c) AS definition FROM pg_constraint c
      WHERE conrelid IN ('admin.config_drafts'::regclass,'admin.config_releases'::regclass)) a USING(oid)
    WHERE a.definition IS DISTINCT FROM b.definition) THEN
    RAISE EXCEPTION 'video_prod_config: config constraints changed';
  END IF;
  IF EXISTS (SELECT FROM pg_temp.video_prod_config_keys
    WHERE admin.is_managed_config_key(config_key) IS DISTINCT FROM editable
      AND config_key IS DISTINCT FROM 'image_plaza_video_model_catalog') THEN
    RAISE EXCEPTION 'video_prod_config: existing key behavior changed';
  END IF;
  IF has_function_privilege('anon','admin.validate_image_plaza_video_model_catalog(jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','admin.validate_image_plaza_video_model_catalog(jsonb)','EXECUTE')
     OR has_function_privilege('service_role','admin.validate_image_plaza_video_model_catalog(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'video_prod_config: validator privilege leak';
  END IF;
END;
$postflight$;

NOTIFY pgrst,'reload schema';
COMMIT;
