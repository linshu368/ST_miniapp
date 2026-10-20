-- domain: experience
-- DATA TEMPLATE: export-image-plaza-seed.mjs supplies the reviewed TEST snapshot.
-- The checked-in empty template intentionally fails; do not run via schema workflow.
-- No new objects/grants. Prerequisites: v2, seed_catalog, seed_large_assets migrations.
-- Copy and verify actual Storage files FIRST. Never INSERT storage.objects manually.
-- Session gate (after independent approval): SET app.seed_storage_verified = 'yes';
-- Recovery: failure rolls back all rows; after commit review ONLY this batch's new
-- source IDs for soft deletion. Never delete existing/referenced artifacts blindly.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL standard_conforming_strings = on;

DO $bootstrap$
DECLARE
  v_payload JSONB := convert_from(decode('__SEED_PAYLOAD_HEX__', 'hex'), 'UTF8')::JSONB;
  v_row JSONB;
  v_work experience.image_plaza_works%ROWTYPE;
  v_artifact experience.image_plaza_artifacts%ROWTYPE;
  v_result JSONB;
  v_inserted INTEGER := 0;
  v_skipped INTEGER := 0;
BEGIN
  IF current_setting('app.seed_storage_verified', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Storage copy/download verification and independent execution approval required';
  END IF;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'seed payload must be an array';
  END IF;
  IF jsonb_array_length(v_payload) NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'seed payload count outside approved capacity';
  END IF;
  IF (SELECT count(DISTINCT value->>'source_image_id') FROM jsonb_array_elements(v_payload))
      <> jsonb_array_length(v_payload) THEN
    RAISE EXCEPTION 'duplicate or missing seed source ID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'image-plaza' AND public = false
      AND (file_size_limit IS NULL OR file_size_limit >= 52428800)
  ) THEN
    RAISE EXCEPTION 'private image-plaza bucket with seed capacity required';
  END IF;

  -- Stable order plus the canonical RPC lock avoids racing with another importer.
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_payload)
    ORDER BY value->>'source_image_id'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM storage.objects
      WHERE bucket_id = 'image-plaza' AND name = v_row->>'storage_path'
        AND (metadata->>'size')::BIGINT = (v_row->>'byte_size')::BIGINT
        AND metadata->>'mimetype' = v_row->>'mime_type'
    ) THEN
      RAISE EXCEPTION 'seed Storage object missing or metadata mismatch';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('image_plaza:civitai:' || (v_row->>'source_image_id'), 0)
    );
    SELECT * INTO v_work FROM experience.image_plaza_works
    WHERE origin = 'civitai_seed' AND source_platform = 'civitai'
      AND source_image_id = v_row->>'source_image_id';

    IF FOUND THEN
      SELECT * INTO STRICT v_artifact FROM experience.image_plaza_artifacts
      WHERE id = v_work.artifact_id;
      -- Production likes are intentionally not compared/reset. A deleted work
      -- must not silently be resurrected by a repeated bootstrap.
      IF v_work.deleted_at IS NOT NULL
        OR v_work.user_id IS NOT NULL OR v_work.attempt_id IS NOT NULL
        OR v_work.title IS DISTINCT FROM v_row->>'title'
        OR v_work.model_id IS DISTINCT FROM v_row->>'model_id'
        OR v_work.model_name IS DISTINCT FROM v_row->>'model_name'
        OR v_work.width IS DISTINCT FROM (v_row->>'width')::INTEGER
        OR v_work.height IS DISTINCT FROM (v_row->>'height')::INTEGER
        OR to_jsonb(v_work.tags) IS DISTINCT FROM v_row->'tags'
        OR v_work.snapshot IS DISTINCT FROM v_row->'snapshot'
        OR v_work.source_image_url IS DISTINCT FROM v_row->>'source_image_url'
        OR v_work.source_heat IS DISTINCT FROM (v_row->>'source_heat')::INTEGER
        OR v_work.published_at IS DISTINCT FROM (v_row->>'published_at')::TIMESTAMPTZ
        OR v_artifact.origin IS DISTINCT FROM 'civitai_seed'
        OR v_artifact.source_platform IS DISTINCT FROM 'civitai'
        OR v_artifact.source_image_id IS DISTINCT FROM v_row->>'source_image_id'
        OR v_artifact.attempt_id IS NOT NULL OR v_artifact.position <> 0
        OR v_artifact.storage_path IS DISTINCT FROM v_row->>'storage_path'
        OR v_artifact.mime_type IS DISTINCT FROM v_row->>'mime_type'
        OR v_artifact.byte_size IS DISTINCT FROM (v_row->>'byte_size')::INTEGER
        OR v_artifact.width IS DISTINCT FROM (v_row->>'width')::INTEGER
        OR v_artifact.height IS DISTINCT FROM (v_row->>'height')::INTEGER THEN
        RAISE EXCEPTION 'existing seed conflicts with reviewed payload; no overwrite allowed';
      END IF;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_result := experience.import_image_plaza_seed_work(
      v_row->>'source_image_id', v_row->>'source_image_url',
      (v_row->>'source_heat')::INTEGER, v_row->>'storage_path', v_row->>'mime_type',
      (v_row->>'byte_size')::INTEGER, (v_row->>'width')::INTEGER,
      (v_row->>'height')::INTEGER, v_row->>'title', v_row->>'model_id',
      v_row->>'model_name', v_row->'snapshot', (v_row->>'published_at')::TIMESTAMPTZ
    );
    IF v_result->>'already_imported' IS DISTINCT FROM 'false'
       OR v_result->>'work_id' IS NULL THEN
      RAISE EXCEPTION 'unexpected seed RPC result';
    END IF;
    -- The canonical importer initializes tags to []; preserve reviewed tags only
    -- on the newly created row, never alter existing production works.
    UPDATE experience.image_plaza_works
    SET tags = ARRAY(SELECT jsonb_array_elements_text(v_row->'tags'))
    WHERE id = (v_result->>'work_id')::UUID;
    v_inserted := v_inserted + 1;
  END LOOP;
  RAISE NOTICE 'seed bootstrap completed: inserted=%, unchanged=%', v_inserted, v_skipped;
END;
$bootstrap$;
COMMIT;