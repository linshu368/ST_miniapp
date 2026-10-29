-- domain: miniapp_features (public character-card interactions, separate from private conversations)
-- Backend-owned; app_core.users/characters are referenced roots. Existing favorites remain authoritative.
-- MIGRATION only: no remote execution implied. Apply before backend/frontend, one file per environment.
-- Rollback: revert clients/backend first and retain interaction data; destructive drop requires separate approval.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE miniapp_features.character_likes (
  character_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT character_likes_pkey PRIMARY KEY(character_id,user_id),
  CONSTRAINT character_likes_character_fkey FOREIGN KEY(character_id) REFERENCES app_core.characters(id) ON DELETE CASCADE,
  CONSTRAINT character_likes_user_fkey FOREIGN KEY(user_id) REFERENCES app_core.users(id) ON DELETE CASCADE
);
CREATE INDEX character_likes_user_idx ON miniapp_features.character_likes(user_id);
COMMENT ON TABLE miniapp_features.character_likes IS 'One independent like per user and character; never inferred from existing favorites';

CREATE TABLE miniapp_features.character_comments (
  id uuid NOT NULL,
  character_id uuid NOT NULL,
  user_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT character_comments_pkey PRIMARY KEY(id),
  CONSTRAINT character_comments_character_fkey FOREIGN KEY(character_id) REFERENCES app_core.characters(id) ON DELETE CASCADE,
  CONSTRAINT character_comments_user_fkey FOREIGN KEY(user_id) REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT character_comments_body_check CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 500
    AND regexp_replace(body,E'[\t\n\r]','','g') !~ '[[:cntrl:]]'
  )
);
CREATE INDEX character_comments_feed_idx ON miniapp_features.character_comments(character_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX character_comments_user_time_idx ON miniapp_features.character_comments(user_id,created_at DESC);
COMMENT ON TABLE miniapp_features.character_comments IS 'Public plain-text character feedback, not private chat history; UUID is idempotency key';
COMMENT ON COLUMN miniapp_features.character_comments.deleted_at IS 'Tombstone prevents timed-out retries from resurrecting an author-deleted comment';

CREATE TABLE miniapp_features.character_comment_reports (
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT character_comment_reports_pkey PRIMARY KEY(comment_id,user_id),
  CONSTRAINT character_comment_reports_comment_fkey FOREIGN KEY(comment_id) REFERENCES miniapp_features.character_comments(id) ON DELETE CASCADE,
  CONSTRAINT character_comment_reports_user_fkey FOREIGN KEY(user_id) REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT character_comment_reports_reason_check CHECK(reason IN ('inappropriate','spam','other'))
);
CREATE INDEX character_comment_reports_user_time_idx ON miniapp_features.character_comment_reports(user_id,created_at DESC);
COMMENT ON TABLE miniapp_features.character_comment_reports IS 'Deduplicated private moderation signals; reporters are never included in public comment responses';

-- Reuse existing idx_character_favorites_character_created(character_id, created_at DESC).
-- Existing favorites and its indexes are unchanged.
ALTER TABLE miniapp_features.character_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.character_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.character_comment_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.character_likes,miniapp_features.character_comments,miniapp_features.character_comment_reports FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON miniapp_features.character_comments TO service_role;
-- All new writes go through service-only functions; no direct client policies or public grants.

CREATE FUNCTION miniapp_features.get_character_socials(p_character_ids uuid[],p_user_id uuid)
RETURNS TABLE(character_id uuid,liked boolean,like_count bigint,favorite_count bigint,comment_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  IF p_user_id IS NULL OR p_character_ids IS NULL OR cardinality(p_character_ids) NOT BETWEEN 1 AND 40
    OR array_position(p_character_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid social query' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
    EXISTS(SELECT 1 FROM miniapp_features.character_likes l WHERE l.character_id=c.id AND l.user_id=p_user_id),
    (SELECT count(*) FROM miniapp_features.character_likes l WHERE l.character_id=c.id),
    (SELECT count(*) FROM miniapp_features.character_favorites f WHERE f.character_id=c.id),
    (SELECT count(*) FROM miniapp_features.character_comments m WHERE m.character_id=c.id AND m.deleted_at IS NULL)
  FROM app_core.characters c
  WHERE c.id=ANY(p_character_ids) AND c.enabled=true AND c.archived_at IS NULL;
END $$;

CREATE FUNCTION miniapp_features.set_character_like(p_character_id uuid,p_user_id uuid,p_liked boolean)
RETURNS TABLE(character_id uuid,liked boolean,like_count bigint,favorite_count bigint,comment_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  IF p_character_id IS NULL OR p_user_id IS NULL OR p_liked IS NULL THEN
    RAISE EXCEPTION 'invalid like' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app_core.characters c WHERE c.id=p_character_id AND c.enabled=true AND c.archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
  -- Serializes opposite desired-state requests across backend replicas without locking other users.
  PERFORM pg_advisory_xact_lock(hashtextextended('character-like:'||p_user_id::text||':'||p_character_id::text,0));
  IF p_liked THEN
    INSERT INTO miniapp_features.character_likes(character_id,user_id) VALUES(p_character_id,p_user_id)
      ON CONFLICT ON CONSTRAINT character_likes_pkey DO NOTHING;
  ELSE
    DELETE FROM miniapp_features.character_likes l WHERE l.character_id=p_character_id AND l.user_id=p_user_id;
  END IF;
  RETURN QUERY SELECT * FROM miniapp_features.get_character_socials(ARRAY[p_character_id],p_user_id);
END $$;

CREATE FUNCTION miniapp_features.create_character_comment(p_id uuid,p_character_id uuid,p_user_id uuid,p_body text)
RETURNS SETOF miniapp_features.character_comments
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE existing miniapp_features.character_comments;
BEGIN
  IF p_id IS NULL OR p_character_id IS NULL OR p_user_id IS NULL OR p_body IS NULL
    OR char_length(btrim(p_body)) NOT BETWEEN 1 AND 500
    OR regexp_replace(p_body,E'[\t\n\r]','','g') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid comment' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app_core.characters c WHERE c.id=p_character_id AND c.enabled=true AND c.archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('character-comment:'||p_user_id::text,0));
  SELECT * INTO existing FROM miniapp_features.character_comments WHERE id=p_id;
  IF FOUND THEN
    IF existing.user_id<>p_user_id OR existing.character_id<>p_character_id OR existing.body<>btrim(p_body) THEN
      RAISE EXCEPTION 'comment key conflict' USING ERRCODE='23505';
    END IF;
    IF existing.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'comment deleted' USING ERRCODE='P0410'; END IF;
    RETURN NEXT existing;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM miniapp_features.character_comments WHERE user_id=p_user_id
      AND created_at>clock_timestamp()-interval '1 minute')>=3 THEN
    RAISE EXCEPTION 'comment rate limit' USING ERRCODE='P0429';
  END IF;
  RETURN QUERY INSERT INTO miniapp_features.character_comments(id,character_id,user_id,body)
    VALUES(p_id,p_character_id,p_user_id,btrim(p_body)) RETURNING *;
END $$;

CREATE FUNCTION miniapp_features.delete_character_comment(p_id uuid,p_character_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  -- Author predicate is inside the trusted write, including replay after frontend navigation.
  UPDATE miniapp_features.character_comments SET deleted_at=clock_timestamp()
    WHERE id=p_id AND character_id=p_character_id AND user_id=p_user_id AND deleted_at IS NULL;
END $$;

CREATE FUNCTION miniapp_features.report_character_comment(p_id uuid,p_character_id uuid,p_user_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  IF p_user_id IS NULL OR p_reason IS NULL OR p_reason NOT IN ('inappropriate','spam','other') THEN
    RAISE EXCEPTION 'invalid report' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app_core.characters c WHERE c.id=p_character_id AND c.enabled=true AND c.archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
  PERFORM 1 FROM miniapp_features.character_comments c WHERE c.id=p_id AND c.character_id=p_character_id AND c.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'comment unavailable' USING ERRCODE='P0404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('character-report:'||p_user_id::text,0));
  IF EXISTS(SELECT 1 FROM miniapp_features.character_comment_reports WHERE comment_id=p_id AND user_id=p_user_id) THEN RETURN; END IF;
  IF (SELECT count(*) FROM miniapp_features.character_comment_reports WHERE user_id=p_user_id
      AND created_at>clock_timestamp()-interval '1 hour')>=10 THEN
    RAISE EXCEPTION 'report rate limit' USING ERRCODE='P0429';
  END IF;
  INSERT INTO miniapp_features.character_comment_reports(comment_id,user_id,reason) VALUES(p_id,p_user_id,p_reason)
    ON CONFLICT ON CONSTRAINT character_comment_reports_pkey DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid),miniapp_features.set_character_like(uuid,uuid,boolean),miniapp_features.create_character_comment(uuid,uuid,uuid,text),miniapp_features.delete_character_comment(uuid,uuid,uuid),miniapp_features.report_character_comment(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid),miniapp_features.set_character_like(uuid,uuid,boolean),miniapp_features.create_character_comment(uuid,uuid,uuid,text),miniapp_features.delete_character_comment(uuid,uuid,uuid),miniapp_features.report_character_comment(uuid,uuid,uuid,text) TO service_role;
COMMENT ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid) IS 'Service-only bounded aggregate lookup; never returns liker or collector identities';
COMMENT ON FUNCTION miniapp_features.set_character_like(uuid,uuid,boolean) IS 'Service-only independent desired-state like; requires currently available character';
COMMENT ON FUNCTION miniapp_features.create_character_comment(uuid,uuid,uuid,text) IS 'Service-only UUID-idempotent public comment; three new comments per viewer per minute across characters';
COMMENT ON FUNCTION miniapp_features.delete_character_comment(uuid,uuid,uuid) IS 'Service-only author-constrained soft deletion; missing and other-owner records are indistinguishable';
COMMENT ON FUNCTION miniapp_features.report_character_comment(uuid,uuid,uuid,text) IS 'Service-only deduplicated report; ten new reports per viewer per hour';
NOTIFY pgrst,'reload schema';
COMMIT;
