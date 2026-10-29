-- domain: media_plaza
-- Forward fix: a TEST seed can retain its immutable video_artifact after its work row
-- is removed. Re-import must reconstruct the missing work instead of failing STRICT.
-- Recovery: restore the prior function body; already reconstructed works remain valid.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION media_plaza.import_video_seed_work(
  p_source_video_id TEXT,
  p_source_video_url TEXT,
  p_source_heat INTEGER,
  p_storage_path TEXT,
  p_byte_size BIGINT,
  p_width INTEGER,
  p_height INTEGER,
  p_duration_ms INTEGER,
  p_poster_path TEXT,
  p_poster_width INTEGER,
  p_poster_height INTEGER,
  p_title TEXT,
  p_description TEXT,
  p_model_id TEXT,
  p_model_name TEXT,
  p_snapshot JSONB,
  p_published_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_artifact media_plaza.video_artifacts%ROWTYPE;
  v_work media_plaza.image_plaza_works%ROWTYPE;
BEGIN
  IF trim(COALESCE(p_source_video_id, '')) = ''
     OR p_source_video_url !~ '^https://'
     OR p_source_heat IS NULL OR p_source_heat < 0
     OR trim(COALESCE(p_storage_path, '')) = ''
     OR char_length(trim(COALESCE(p_title, ''))) NOT BETWEEN 1 AND 80
     OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
     OR char_length(trim(COALESCE(p_snapshot->>'prompt', ''))) < 1
     OR char_length(trim(COALESCE(p_snapshot->>'prompt_zh', ''))) < 1
     OR p_snapshot->>'model_id' IS DISTINCT FROM p_model_id
     OR p_published_at IS NULL THEN
    RAISE EXCEPTION 'invalid video plaza seed work' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('media_plaza:video:' || p_source_video_id, 0));
  SELECT * INTO v_artifact FROM media_plaza.video_artifacts
  WHERE origin = 'civitai_seed' AND source_video_id = p_source_video_id;

  IF FOUND THEN
    SELECT * INTO v_work FROM media_plaza.image_plaza_works
    WHERE video_artifact_id = v_artifact.id;
    IF FOUND THEN
      IF v_artifact.storage_path IS DISTINCT FROM p_storage_path
         OR v_artifact.source_video_url IS DISTINCT FROM p_source_video_url
         OR v_work.snapshot IS DISTINCT FROM p_snapshot THEN
        RAISE EXCEPTION 'video plaza seed idempotency conflict' USING ERRCODE = '23505';
      END IF;
      RETURN jsonb_build_object('work_id', v_work.id, 'artifact_id', v_artifact.id,
        'already_imported', true);
    END IF;

    -- Storage-backed artifacts are immutable. Only repair a missing work when every
    -- artifact field still matches the verified seed manifest.
    IF v_artifact.storage_path IS DISTINCT FROM p_storage_path
       OR v_artifact.byte_size IS DISTINCT FROM p_byte_size
       OR v_artifact.width IS DISTINCT FROM p_width
       OR v_artifact.height IS DISTINCT FROM p_height
       OR v_artifact.duration_ms IS DISTINCT FROM p_duration_ms
       OR v_artifact.poster_path IS DISTINCT FROM p_poster_path
       OR v_artifact.poster_width IS DISTINCT FROM p_poster_width
       OR v_artifact.poster_height IS DISTINCT FROM p_poster_height
       OR v_artifact.source_video_url IS DISTINCT FROM p_source_video_url THEN
      RAISE EXCEPTION 'video plaza seed orphan artifact conflict' USING ERRCODE = '23505';
    END IF;
  ELSE
    INSERT INTO media_plaza.video_artifacts(
      origin, storage_path, byte_size, width, height, duration_ms,
      poster_path, poster_width, poster_height, source_video_id, source_video_url
    ) VALUES (
      'civitai_seed', p_storage_path, p_byte_size, p_width, p_height, p_duration_ms,
      p_poster_path, p_poster_width, p_poster_height, p_source_video_id, p_source_video_url
    ) RETURNING * INTO v_artifact;
  END IF;

  INSERT INTO media_plaza.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name, width, height,
    tags, snapshot, published_at, origin, source_heat, media_type,
    video_artifact_id, video_attempt_id, duration_ms, description,
    source_video_id, source_video_url
  ) VALUES (
    NULL, NULL, NULL, trim(p_title), trim(p_model_id), trim(p_model_name), p_width, p_height,
    '{}', p_snapshot, p_published_at, 'civitai_seed', p_source_heat, 'video',
    v_artifact.id, NULL, p_duration_ms, left(COALESCE(p_description, ''), 500),
    p_source_video_id, p_source_video_url
  ) RETURNING * INTO v_work;

  RETURN jsonb_build_object('work_id', v_work.id, 'artifact_id', v_artifact.id,
    'already_imported', false);
END;
$$;

REVOKE ALL ON FUNCTION media_plaza.import_video_seed_work(
  TEXT, TEXT, INTEGER, TEXT, BIGINT, INTEGER, INTEGER, INTEGER, TEXT, INTEGER,
  INTEGER, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION media_plaza.import_video_seed_work(
  TEXT, TEXT, INTEGER, TEXT, BIGINT, INTEGER, INTEGER, INTEGER, TEXT, INTEGER,
  INTEGER, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) TO service_role, postgres;

DO $$
BEGIN
  IF has_function_privilege(
       'anon',
       'media_plaza.import_video_seed_work(text,text,integer,text,bigint,integer,integer,integer,text,integer,integer,text,text,text,text,jsonb,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'media_plaza.import_video_seed_work(text,text,integer,text,bigint,integer,integer,integer,text,integer,integer,text,text,text,text,jsonb,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'video seed import privilege leak';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
