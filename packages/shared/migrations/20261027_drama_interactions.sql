-- domain: drama_archive (official-drama interactions; user-approved existing drama domain)
-- Owners: ST_miniapp backend owns these new tables; telegram-video-archive keeps its original tables.
-- Apply before backend/frontend. No existing rows changed; no production execution in local preview.
-- Rollback: roll back clients/backend first, retain data. Only after explicit data-disposal approval:
-- DROP FUNCTION drama_archive.create_drama_comment(uuid,uuid,uuid,text);
-- DROP TABLE drama_archive.drama_comments, drama_archive.drama_likes;
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE drama_archive.drama_likes (
  drama_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drama_likes_pkey PRIMARY KEY (drama_id,user_id),
  CONSTRAINT drama_likes_drama_fkey FOREIGN KEY (drama_id) REFERENCES drama_archive.dramas(id) ON DELETE CASCADE,
  CONSTRAINT drama_likes_user_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id) ON DELETE CASCADE
);
CREATE INDEX drama_likes_user_idx ON drama_archive.drama_likes(user_id);
COMMENT ON TABLE drama_archive.drama_likes IS 'One viewer like per official drama; backend-owned, no creator/follow relationship';

CREATE TABLE drama_archive.drama_comments (
  id uuid NOT NULL,
  drama_id uuid NOT NULL,
  user_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT drama_comments_pkey PRIMARY KEY(id),
  CONSTRAINT drama_comments_drama_fkey FOREIGN KEY (drama_id) REFERENCES drama_archive.dramas(id) ON DELETE CASCADE,
  CONSTRAINT drama_comments_user_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT drama_comments_body_check CHECK (char_length(btrim(body)) BETWEEN 1 AND 500)
);
CREATE INDEX drama_comments_feed_idx ON drama_archive.drama_comments(drama_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX drama_comments_user_time_idx ON drama_archive.drama_comments(user_id,created_at DESC);
COMMENT ON TABLE drama_archive.drama_comments IS 'Plain-text official-drama viewer comments; UUID is publication idempotency key';

ALTER TABLE drama_archive.drama_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE drama_archive.drama_comments ENABLE ROW LEVEL SECURITY;
-- Clear inherited default grants as well; GRANT alone cannot narrow an earlier broad default.
REVOKE ALL ON drama_archive.drama_likes, drama_archive.drama_comments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT,INSERT,DELETE ON drama_archive.drama_likes TO service_role;
GRANT SELECT ON drama_archive.drama_comments TO service_role;
GRANT UPDATE(deleted_at) ON drama_archive.drama_comments TO service_role;

-- The transaction lock protects the rolling limit across concurrent requests/replicas.
-- Retry checks happen before the limit; an accepted submission remains recoverable after timeout.
CREATE FUNCTION drama_archive.create_drama_comment(p_id uuid,p_drama_id uuid,p_user_id uuid,p_body text)
RETURNS SETOF drama_archive.drama_comments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE existing drama_archive.drama_comments;
BEGIN
  IF p_id IS NULL OR p_drama_id IS NULL OR p_user_id IS NULL OR p_body IS NULL
    OR char_length(btrim(p_body)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid comment' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('drama-comment:' || p_user_id::text,0));
  SELECT * INTO existing FROM drama_archive.drama_comments WHERE id=p_id;
  IF FOUND THEN
    IF existing.user_id<>p_user_id OR existing.drama_id<>p_drama_id OR existing.body<>btrim(p_body) THEN
      RAISE EXCEPTION 'comment key conflict' USING ERRCODE='23505';
    END IF;
    IF existing.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'comment deleted' USING ERRCODE='P0410';
    END IF;
    RETURN NEXT existing;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM drama_archive.drama_comments WHERE user_id=p_user_id
      AND created_at>clock_timestamp()-interval '1 minute') >= 3 THEN
    RAISE EXCEPTION 'comment rate limit' USING ERRCODE='P0429';
  END IF;
  RETURN QUERY INSERT INTO drama_archive.drama_comments(id,drama_id,user_id,body)
    VALUES(p_id,p_drama_id,p_user_id,btrim(p_body)) RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION drama_archive.create_drama_comment(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION drama_archive.create_drama_comment(uuid,uuid,uuid,text) TO service_role;
COMMENT ON FUNCTION drama_archive.create_drama_comment(uuid,uuid,uuid,text) IS 'Service-only idempotent publication, maximum three new comments per viewer per minute';
NOTIFY pgrst,'reload schema';
COMMIT;
