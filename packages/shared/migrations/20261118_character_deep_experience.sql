-- domain: miniapp_features (derived public character-card engagement summary)
-- Deep experience is a daily snapshot. One user × character session is split when
-- consecutive logical turns are more than 30 minutes apart; a session with >20
-- turns contributes one count. Structured revisions are deduplicated by turn.
-- Release: TEST migration -> production migration -> Backend deployment.
-- Recovery: revert the Backend/RPC consumer first; retain this table and summary
-- data. The old like_count calculation remains valid if this migration is reverted.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS miniapp_features.character_deep_experience_stats (
  character_id uuid PRIMARY KEY
    REFERENCES app_core.characters(id) ON DELETE CASCADE,
  deep_session_count bigint NOT NULL DEFAULT 0
    CONSTRAINT character_deep_experience_stats_count_check CHECK (deep_session_count >= 0),
  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE miniapp_features.character_deep_experience_stats IS
  'Daily cumulative count of user sessions with more than 20 logical turns on a character card; written by the lobby refresh job.';
COMMENT ON COLUMN miniapp_features.character_deep_experience_stats.deep_session_count IS
  'A session is split when consecutive turns are more than 30 minutes apart; 21 or more turns count once. Revisions of one logical turn are deduplicated.';

ALTER TABLE miniapp_features.character_deep_experience_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.character_deep_experience_stats FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON miniapp_features.character_deep_experience_stats TO service_role;

CREATE OR REPLACE FUNCTION miniapp_features.get_character_socials(
  p_character_ids uuid[],
  p_user_id uuid
)
RETURNS TABLE(
  character_id uuid,
  liked boolean,
  like_count bigint,
  favorite_count bigint,
  comment_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_character_ids IS NULL OR cardinality(p_character_ids) NOT BETWEEN 1 AND 40
     OR array_position(p_character_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid social query' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
    EXISTS(
      SELECT 1
      FROM miniapp_features.character_likes l
      WHERE l.character_id = c.id AND l.user_id = p_user_id
    ),
    (SELECT count(*) FROM miniapp_features.character_likes l WHERE l.character_id = c.id)
      + COALESCE(r.reply_like_count, 0)
      + COALESCE(d.deep_session_count, 0),
    (SELECT count(*) FROM miniapp_features.character_favorites f WHERE f.character_id = c.id),
    (SELECT count(*) FROM miniapp_features.character_comments m
      WHERE m.character_id = c.id AND m.deleted_at IS NULL)
  FROM app_core.characters c
  LEFT JOIN experience.get_character_reply_like_counts(p_character_ids) r
    ON r.character_id = c.id
  LEFT JOIN miniapp_features.character_deep_experience_stats d
    ON d.character_id = c.id
  WHERE c.id = ANY(p_character_ids)
    AND app_core.can_use_character(p_user_id, c.id);
END;
$fn$;

COMMENT ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid) IS
  'Service-only bounded aggregate; like_count combines direct card likes, explicit reply likes, and daily deep-experience session counts. liked remains the viewer direct-card state.';

REVOKE ALL ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
