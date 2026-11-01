-- domain: media_plaza
-- M4: let a ready, user-owned image artifact act as a video reference without copying bytes.
-- The source image artifact remains authoritative for object lifecycle; the mapped reference row
-- only supplies the existing reference contract to image/video generation consumers.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('media_plaza.image_plaza_reference_assets') IS NULL
     OR to_regclass('media_plaza.image_plaza_artifacts') IS NULL
     OR to_regclass('media_plaza.image_plaza_attempts') IS NULL THEN
    RAISE EXCEPTION 'media plaza image artifact reference prerequisites are missing';
  END IF;
END;
$preflight$;

ALTER TABLE media_plaza.image_plaza_reference_assets
  ADD COLUMN source_image_artifact_id UUID;

ALTER TABLE media_plaza.image_plaza_reference_assets
  ADD CONSTRAINT image_plaza_reference_assets_source_image_artifact_fkey
  FOREIGN KEY (source_image_artifact_id)
  REFERENCES media_plaza.image_plaza_artifacts(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX image_plaza_reference_assets_source_image_artifact_unique
  ON media_plaza.image_plaza_reference_assets(source_image_artifact_id)
  WHERE source_image_artifact_id IS NOT NULL;

COMMENT ON COLUMN media_plaza.image_plaza_reference_assets.source_image_artifact_id IS
  'Ready image artifact reused as this reference. Storage bytes remain owned by the source artifact.';

CREATE OR REPLACE FUNCTION media_plaza.get_or_create_video_reference_from_image_artifact(
  p_user_id UUID,
  p_artifact_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_artifact media_plaza.image_plaza_artifacts%ROWTYPE;
  v_attempt media_plaza.image_plaza_attempts%ROWTYPE;
  v_reference media_plaza.image_plaza_reference_assets%ROWTYPE;
BEGIN
  SELECT * INTO v_artifact
  FROM media_plaza.image_plaza_artifacts
  WHERE id = p_artifact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'image artifact not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_attempt
  FROM media_plaza.image_plaza_attempts
  WHERE id = v_artifact.attempt_id;
  IF NOT FOUND
     OR v_attempt.user_id IS DISTINCT FROM p_user_id
     OR v_attempt.status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'image artifact not accessible' USING ERRCODE = '42501';
  END IF;

  INSERT INTO media_plaza.image_plaza_reference_assets(
    user_id, storage_path, mime_type, byte_size, width, height, source_image_artifact_id
  ) VALUES (
    p_user_id, v_artifact.storage_path, v_artifact.mime_type, v_artifact.byte_size,
    v_artifact.width, v_artifact.height, v_artifact.id
  )
  ON CONFLICT (source_image_artifact_id)
    WHERE source_image_artifact_id IS NOT NULL
  DO UPDATE SET source_image_artifact_id = EXCLUDED.source_image_artifact_id
  RETURNING * INTO v_reference;

  IF v_reference.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'image artifact reference owner mismatch' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'id', v_reference.id,
    'storage_path', v_reference.storage_path,
    'width', v_reference.width,
    'height', v_reference.height
  );
END;
$$;

COMMENT ON FUNCTION media_plaza.get_or_create_video_reference_from_image_artifact(UUID, UUID) IS
  'Idempotently maps a ready user-owned image artifact into the private generation reference contract.';

REVOKE ALL ON FUNCTION media_plaza.get_or_create_video_reference_from_image_artifact(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION media_plaza.get_or_create_video_reference_from_image_artifact(UUID, UUID)
  TO service_role, postgres;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'media_plaza.image_plaza_reference_assets'::regclass
      AND attname = 'source_image_artifact_id'
      AND atttypid = 'uuid'::regtype
      AND NOT attisdropped
  ) OR to_regprocedure(
    'media_plaza.get_or_create_video_reference_from_image_artifact(uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'media plaza image artifact reference postflight failed';
  END IF;
END;
$postflight$;

COMMIT;
