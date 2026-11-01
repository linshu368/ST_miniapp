-- domain: admin
-- Forward-only validator expansion for grouped image/video plaza tags.
-- No runtime rows are changed. Existing media_types remains accepted for old drafts/releases,
-- but current application consumers ignore it and expose every enabled tag to both media types.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.validate_image_plaza_tags(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'image plaza grouped-tag validator prerequisites are missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION admin.validate_image_plaza_tags(p_value JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  v_tag JSONB;
  v_media JSONB;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_media_ids TEXT[];
  v_group_ids TEXT[] := ARRAY[]::TEXT[];
  v_group_labels TEXT[] := ARRAY[]::TEXT[];
  v_group_sort_orders INTEGER[] := ARRAY[]::INTEGER[];
  v_group_layouts TEXT[] := ARRAY[]::TEXT[];
  v_group_id TEXT;
  v_group_label TEXT;
  v_group_sort_order INTEGER;
  v_group_layout TEXT;
  v_group_index INTEGER;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR jsonb_array_length(p_value) > 80 THEN
    RAISE EXCEPTION 'image_plaza_tags has invalid shape' USING ERRCODE = '22023';
  END IF;

  FOR v_tag IN SELECT value FROM jsonb_array_elements(p_value) LOOP
    IF jsonb_typeof(v_tag) IS DISTINCT FROM 'object'
       OR char_length(btrim(COALESCE(v_tag->>'id', ''))) NOT BETWEEN 1 AND 40
       OR v_tag->>'id' = 'all'
       OR char_length(btrim(COALESCE(v_tag->>'label', ''))) NOT BETWEEN 1 AND 40
       OR jsonb_typeof(v_tag->'enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_tag->'sort_order') IS DISTINCT FROM 'number'
       OR COALESCE(v_tag->>'sort_order', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'image plaza tag is invalid' USING ERRCODE = '22023';
    END IF;
    IF (v_tag->>'id') = ANY(v_ids) THEN
      RAISE EXCEPTION 'image plaza tag id is duplicated' USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_tag->>'id');

    IF (v_tag ? 'group_id' AND jsonb_typeof(v_tag->'group_id') IS DISTINCT FROM 'string')
       OR (v_tag ? 'group_label' AND jsonb_typeof(v_tag->'group_label') IS DISTINCT FROM 'string')
       OR (v_tag ? 'group_sort_order' AND jsonb_typeof(v_tag->'group_sort_order') IS DISTINCT FROM 'number')
       OR (v_tag ? 'group_layout' AND jsonb_typeof(v_tag->'group_layout') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'image plaza tag group fields have invalid types' USING ERRCODE = '22023';
    END IF;

    v_group_id := btrim(COALESCE(v_tag->>'group_id', 'style'));
    v_group_label := btrim(COALESCE(v_tag->>'group_label', '风格'));
    v_group_layout := COALESCE(v_tag->>'group_layout', 'chips');
    IF COALESCE(v_tag->>'group_sort_order', '0') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'image plaza tag group order is invalid' USING ERRCODE = '22023';
    END IF;
    v_group_sort_order := COALESCE((v_tag->>'group_sort_order')::INTEGER, 0);

    IF char_length(v_group_id) NOT BETWEEN 1 AND 40
       OR v_group_id = 'all'
       OR char_length(v_group_label) NOT BETWEEN 1 AND 40
       OR v_group_layout NOT IN ('chips', 'grid') THEN
      RAISE EXCEPTION 'image plaza tag group is invalid' USING ERRCODE = '22023';
    END IF;

    v_group_index := array_position(v_group_ids, v_group_id);
    IF v_group_index IS NULL THEN
      v_group_ids := array_append(v_group_ids, v_group_id);
      v_group_labels := array_append(v_group_labels, v_group_label);
      v_group_sort_orders := array_append(v_group_sort_orders, v_group_sort_order);
      v_group_layouts := array_append(v_group_layouts, v_group_layout);
    ELSIF v_group_labels[v_group_index] IS DISTINCT FROM v_group_label
       OR v_group_sort_orders[v_group_index] IS DISTINCT FROM v_group_sort_order
       OR v_group_layouts[v_group_index] IS DISTINCT FROM v_group_layout THEN
      RAISE EXCEPTION 'image plaza tag group metadata conflicts for %', v_group_id
        USING ERRCODE = '22023';
    END IF;

    -- Legacy-only compatibility. Current Admin no longer writes this field.
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

REVOKE ALL ON FUNCTION admin.validate_image_plaza_tags(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

DO $self_check$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  PERFORM admin.validate_image_plaza_tags(
    '[{"id":"portrait","label":"人像","enabled":true,"sort_order":0,"media_types":["image"]}]'::JSONB
  );
  PERFORM admin.validate_image_plaza_tags(
    '[{"id":"indoor","label":"室内居家","enabled":true,"sort_order":0,"group_id":"scene","group_label":"场景","group_sort_order":2,"group_layout":"chips"},{"id":"outdoor","label":"户外","enabled":true,"sort_order":1,"group_id":"scene","group_label":"场景","group_sort_order":2,"group_layout":"chips"}]'::JSONB
  );

  BEGIN
    PERFORM admin.validate_image_plaza_tags(
      '[{"id":"indoor","label":"室内","enabled":true,"sort_order":0,"group_id":"scene","group_label":"场景","group_sort_order":2,"group_layout":"chips"},{"id":"outdoor","label":"户外","enabled":true,"sort_order":1,"group_id":"scene","group_label":"地点","group_sort_order":2,"group_layout":"grid"}]'::JSONB
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'image plaza grouped-tag validator accepted conflicting group metadata';
  END IF;
END;
$self_check$;

COMMIT;
