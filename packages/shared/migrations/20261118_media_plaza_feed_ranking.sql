-- domain: media_plaza
-- Additive v2 ranking. Keep works.initial_feed_order unchanged for old readers.
-- Manual: TEST first; rollback consumers first and retain this derived index.
-- Idempotent: safe when table/functions/index already exist (e.g. prior manual TEST apply).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS media_plaza.image_plaza_feed_scores (
  work_id uuid PRIMARY KEY REFERENCES media_plaza.image_plaza_works(id) ON DELETE CASCADE,
  initial_feed_order bigint NOT NULL UNIQUE CHECK (initial_feed_order > 0),
  ranking_revision uuid NOT NULL
);
ALTER TABLE media_plaza.image_plaza_feed_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON media_plaza.image_plaza_feed_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON media_plaza.image_plaza_feed_scores TO service_role;
COMMENT ON TABLE media_plaza.image_plaza_feed_scores IS
  'D: current rebuildable model-balanced image/video feed order; private backend reader only';

CREATE OR REPLACE FUNCTION media_plaza.rebuild_image_plaza_feed_order()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, media_plaza
SET lock_timeout = '5s'
SET statement_timeout = '60s'
AS $$
DECLARE
  v_revision uuid := gen_random_uuid();
  v_count integer;
BEGIN
  -- Readers share this lock only for their bounded SQL read, never while signing media.
  PERFORM pg_advisory_xact_lock(hashtextextended('media_plaza.image_plaza_feed_scores', 0));
  SELECT count(*) INTO v_count FROM (
    SELECT 1 FROM media_plaza.image_plaza_works WHERE deleted_at IS NULL LIMIT 100001
  ) candidates;
  IF v_count > 100000 THEN
    RAISE EXCEPTION 'image_plaza_feed_capacity_exceeded';
  END IF;

  DELETE FROM media_plaza.image_plaza_feed_scores;
  WITH candidates AS (
    SELECT id, source_heat,
      media_type || ':' || coalesce(nullif(model_id, ''), nullif(model_name, ''), 'unknown') AS model_key,
      CASE WHEN source_heat > 0 THEN 0 ELSE 1 END AS heat_group
    FROM media_plaza.image_plaza_works WHERE deleted_at IS NULL
  ), model_ranks AS (
    SELECT id, model_key, heat_group,
      row_number() OVER (
        PARTITION BY model_key, heat_group ORDER BY source_heat DESC NULLS LAST, id DESC
      ) AS relative_heat_rank
    FROM candidates
  )
  INSERT INTO media_plaza.image_plaza_feed_scores(work_id, initial_feed_order, ranking_revision)
  SELECT id, row_number() OVER (
    ORDER BY heat_group, relative_heat_rank, model_key COLLATE "C", id DESC
  ), v_revision FROM model_ranks;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- Imports can commit between the preflight count and INSERT's snapshot.
  IF v_count > 100000 THEN
    RAISE EXCEPTION 'image_plaza_feed_capacity_exceeded';
  END IF;
  -- Batch imports/new generations need fresh join selectivity before their first feed read.
  IF v_count = 0 THEN
    v_revision := '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;
  ANALYZE media_plaza.image_plaza_works;
  ANALYZE media_plaza.image_plaza_feed_scores;
  RETURN jsonb_build_object('ranking_revision', v_revision, 'count', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION media_plaza.read_image_plaza_recommended_feed(
  p_media text DEFAULT 'all', p_search text DEFAULT '', p_tag_labels text[] DEFAULT '{}',
  p_limit integer DEFAULT 20, p_revision uuid DEFAULT NULL, p_partition text DEFAULT NULL,
  p_like_count integer DEFAULT NULL, p_order bigint DEFAULT NULL, p_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, media_plaza
SET lock_timeout = '2s'
SET statement_timeout = '8s'
AS $$
DECLARE
  v_revision uuid;
  v_items jsonb;
  v_pattern text;
BEGIN
  IF p_media IS NULL OR p_media NOT IN ('all', 'image', 'video')
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 20
     OR length(coalesce(p_search, '')) > 80
     OR cardinality(p_tag_labels) > 80
     OR EXISTS (SELECT 1 FROM unnest(p_tag_labels) label WHERE length(label) > 80 OR label IS NULL)
     OR (p_partition IS NOT NULL AND p_partition NOT IN ('liked', 'zero'))
     OR (p_partition IS NOT NULL AND (p_id IS NULL OR p_revision IS NULL))
     OR (p_partition = 'liked' AND (p_like_count IS NULL OR p_like_count < 1))
     OR (p_order IS NOT NULL AND p_order < 1) THEN
    RAISE EXCEPTION 'image_plaza_feed_invalid_arguments';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('media_plaza.image_plaza_feed_scores', 0));
  SELECT ranking_revision INTO v_revision FROM media_plaza.image_plaza_feed_scores LIMIT 1;
  v_revision := coalesce(v_revision, '00000000-0000-0000-0000-000000000000'::uuid);
  IF p_revision IS NOT NULL AND p_revision <> v_revision THEN
    RAISE EXCEPTION 'IMAGE_PLAZA_INVALID_CURSOR';
  END IF;
  -- User search/tag text is literal, not wildcard or SQL syntax.
  v_pattern := '%' || replace(replace(replace(coalesce(p_search, ''),
    chr(92), chr(92)||chr(92)), '%', chr(92)||'%'), '_', chr(92)||'_') || '%';

  WITH filtered AS NOT MATERIALIZED (
    SELECT w.id, w.user_id, w.attempt_id, w.artifact_id, w.title, w.model_id, w.model_name,
      w.width, w.height, w.tags, w.snapshot, w.like_count, w.published_at, w.deleted_at,
      w.media_type, w.video_artifact_id, w.video_attempt_id, w.duration_ms, w.description
    FROM media_plaza.image_plaza_works w
    WHERE w.deleted_at IS NULL AND (p_media = 'all' OR w.media_type = p_media)
      AND (coalesce(p_search, '') = '' OR w.snapshot->>'prompt' ILIKE v_pattern
        OR w.snapshot->>'prompt_zh' ILIKE v_pattern)
      AND (coalesce(cardinality(p_tag_labels), 0) = 0 OR EXISTS (
        SELECT 1 FROM unnest(p_tag_labels) label
        WHERE w.snapshot->>'prompt_zh' ILIKE '%' || replace(replace(replace(label,
          chr(92), chr(92)||chr(92)), '%', chr(92)||'%'), '_', chr(92)||'_') || '%'
      ))
  ), liked AS MATERIALIZED (
    SELECT filtered.*, NULL::bigint AS order_value FROM filtered
    WHERE like_count > 0 AND p_partition IS DISTINCT FROM 'zero'
      AND (p_partition IS NULL OR like_count < p_like_count OR (like_count = p_like_count AND id < p_id))
    ORDER BY like_count DESC, id DESC LIMIT p_limit + 1
  ), ranked_zero AS MATERIALIZED (
    -- Drive the common path from the unique rank index, not a whole-catalog LEFT JOIN sort.
    SELECT filtered.*, s.initial_feed_order AS order_value
    FROM media_plaza.image_plaza_feed_scores s JOIN filtered ON filtered.id = s.work_id
    WHERE like_count = 0 AND (SELECT count(*) FROM liked) < p_limit + 1
      AND (p_partition IS DISTINCT FROM 'zero' OR (p_order IS NOT NULL AND s.initial_feed_order > p_order))
    ORDER BY s.initial_feed_order ASC LIMIT p_limit + 1
  ), unranked_zero AS (
    SELECT filtered.*, NULL::bigint AS order_value FROM filtered
    WHERE like_count = 0 AND (SELECT count(*) FROM liked) < p_limit + 1
      AND (SELECT count(*) FROM ranked_zero) < p_limit + 1
      AND NOT EXISTS (SELECT 1 FROM media_plaza.image_plaza_feed_scores s WHERE s.work_id = filtered.id)
      AND (p_partition IS DISTINCT FROM 'zero' OR p_order IS NOT NULL OR id < p_id)
    ORDER BY id DESC LIMIT p_limit + 1
  ), zero_likes AS (
    SELECT * FROM (SELECT * FROM ranked_zero UNION ALL SELECT * FROM unranked_zero) zeros
    ORDER BY order_value ASC NULLS LAST, id DESC LIMIT p_limit + 1
  ), page AS (
    SELECT * FROM (SELECT * FROM liked UNION ALL SELECT * FROM zero_likes) candidates
    ORDER BY like_count DESC, CASE WHEN like_count = 0 THEN order_value END ASC NULLS LAST, id DESC
    LIMIT p_limit + 1
  )
  SELECT coalesce(jsonb_agg(to_jsonb(page) - 'order_value'
    || jsonb_build_object('initial_feed_order', order_value::text)
    ORDER BY like_count DESC, CASE WHEN like_count = 0 THEN order_value END ASC NULLS LAST, id DESC), '[]')
  INTO v_items FROM page;
  RETURN jsonb_build_object('ranking_revision', v_revision, 'items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION media_plaza.rebuild_image_plaza_feed_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION media_plaza.read_image_plaza_recommended_feed(text,text,text[],integer,uuid,text,integer,bigint,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION media_plaza.rebuild_image_plaza_feed_order() TO service_role;
GRANT EXECUTE ON FUNCTION media_plaza.read_image_plaza_recommended_feed(text,text,text[],integer,uuid,text,integer,bigint,uuid)
  TO service_role;
CREATE INDEX IF NOT EXISTS image_plaza_works_liked_v2_idx ON media_plaza.image_plaza_works(like_count DESC, id DESC)
  WHERE deleted_at IS NULL AND like_count > 0;
SELECT media_plaza.rebuild_image_plaza_feed_order();
NOTIFY pgrst, 'reload schema';
COMMIT;
