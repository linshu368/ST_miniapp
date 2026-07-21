-- 052_character_favorites.sql
-- Persistent per-user character favorites and Admin favorite leaderboard.

CREATE TABLE IF NOT EXISTS miniapp.character_favorites (
  user_id UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, character_id)
);

CREATE INDEX IF NOT EXISTS idx_character_favorites_user_created
  ON miniapp.character_favorites(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_character_favorites_character_created
  ON miniapp.character_favorites(character_id, created_at DESC);

ALTER TABLE miniapp.character_favorites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.character_favorites FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.character_favorites TO service_role, postgres;

CREATE OR REPLACE FUNCTION miniapp.set_character_favorite(
  p_user_id UUID,
  p_character_id UUID,
  p_favorited BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_exists BOOLEAN;
  v_count BIGINT;
BEGIN
  IF p_user_id IS NULL OR p_character_id IS NULL OR p_favorited IS NULL THEN
    RAISE EXCEPTION 'invalid character favorite input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::TEXT || ':' || p_character_id::TEXT, 0)
  );

  IF p_favorited THEN
    SELECT EXISTS (
      SELECT 1
      FROM miniapp.characters
      WHERE id = p_character_id
        AND enabled = true
        AND archived_at IS NULL
    ) INTO v_exists;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'character is unavailable: %', p_character_id
        USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO miniapp.character_favorites(user_id, character_id)
    VALUES (p_user_id, p_character_id)
    ON CONFLICT (user_id, character_id) DO NOTHING;
  ELSE
    DELETE FROM miniapp.character_favorites
    WHERE user_id = p_user_id AND character_id = p_character_id;
  END IF;

  SELECT count(*) INTO v_count
  FROM miniapp.character_favorites
  WHERE character_id = p_character_id;

  RETURN jsonb_build_object(
    'character_id', p_character_id,
    'favorited', p_favorited,
    'favorite_count', v_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.list_character_favorites(
  p_user_id UUID
) RETURNS TABLE(character_id UUID, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT favorites.character_id, favorites.created_at
  FROM miniapp.character_favorites AS favorites
  JOIN miniapp.characters AS characters ON characters.id = favorites.character_id
  WHERE favorites.user_id = p_user_id
    AND characters.enabled = true
    AND characters.archived_at IS NULL
  ORDER BY favorites.created_at DESC
$$;

CREATE OR REPLACE FUNCTION miniapp.get_character_favorite_counts(
  p_character_ids UUID[]
) RETURNS TABLE(character_id UUID, favorite_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT ids.character_id, count(favorites.user_id)
  FROM unnest(COALESCE(p_character_ids, ARRAY[]::UUID[])) AS ids(character_id)
  LEFT JOIN miniapp.character_favorites AS favorites
    ON favorites.character_id = ids.character_id
  GROUP BY ids.character_id
$$;

CREATE OR REPLACE FUNCTION admin.list_character_favorite_leaderboard(
  p_from TIMESTAMPTZ DEFAULT (now() - interval '30 days'),
  p_to TIMESTAMPTZ DEFAULT now(),
  p_limit INTEGER DEFAULT 50
) RETURNS TABLE(
  rank BIGINT,
  character_id UUID,
  character_name TEXT,
  enabled BOOLEAN,
  favorite_count BIGINT,
  new_favorite_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.analytics_require_access(false);
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to
     OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'favorite leaderboard range is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'favorite leaderboard limit is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH favorite_counts AS (
    SELECT
      characters.id,
      characters.name,
      characters.enabled AND characters.archived_at IS NULL AS is_enabled,
      count(favorites.user_id) AS total_count,
      count(favorites.user_id) FILTER (
        WHERE favorites.created_at >= p_from AND favorites.created_at < p_to
      ) AS period_count
    FROM miniapp.characters AS characters
    LEFT JOIN miniapp.character_favorites AS favorites
      ON favorites.character_id = characters.id
    GROUP BY characters.id, characters.name, characters.enabled, characters.archived_at
  )
  SELECT
    row_number() OVER (ORDER BY total_count DESC, period_count DESC, name ASC),
    id,
    name,
    is_enabled,
    total_count,
    period_count
  FROM favorite_counts
  ORDER BY total_count DESC, period_count DESC, name ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION miniapp.set_character_favorite(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION miniapp.list_character_favorites(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION miniapp.get_character_favorite_counts(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.list_character_favorite_leaderboard(
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION miniapp.set_character_favorite(UUID, UUID, BOOLEAN)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.list_character_favorites(UUID)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.get_character_favorite_counts(UUID[])
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.list_character_favorite_leaderboard(
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) TO authenticated, service_role, postgres;

COMMENT ON TABLE miniapp.character_favorites IS
  'Persistent user-to-character favorites; aggregate counts are derived from this relation.';

NOTIFY pgrst, 'reload schema';
