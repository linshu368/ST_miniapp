-- domain: experience. A like belongs to a fixed reply version as seen in one
-- owned conversation, including inherited replies. Character totals combine these
-- facts with direct card likes through a read-only domain accessor, without copying.
-- Prerequisite: character social + conversation branches migrations, then this file.
-- Verification: bash scripts/test-conversation-branches-migration.sh
-- Release: TEST validation -> production migration -> Backend -> Frontend.
-- Recovery: older applications may ignore liked; retain the table and facts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE columns text[]; expected text[] := ARRAY[
  'id','user_id','model','user_input','assistant_reply','history','character_id',
  'status','upstream_status','deduction_rate','created_at','llm_finish_reason',
  'llm_charge_id','session_id','turn_index','revision','postprocess_version',
  'rich_reply_metadata','first_token_preview','is_inherited'
];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO columns
  FROM pg_attribute a WHERE a.attrelid=to_regclass('experience.session_chat_history')
    AND a.attnum>0 AND NOT a.attisdropped;
  IF columns IS NULL OR (columns<>expected AND columns<>array_append(expected,'liked')) THEN
    RAISE EXCEPTION 'reply likes require the reviewed conversation branch view';
  END IF;
  IF to_regprocedure('miniapp_features.get_character_socials(uuid[],uuid)') IS NULL THEN
    RAISE EXCEPTION 'reply like totals require character social aggregation';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS experience.chat_message_likes (
  session_id uuid NOT NULL,
  message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_message_likes_pkey PRIMARY KEY(session_id,message_id),
  CONSTRAINT chat_message_likes_session_fkey FOREIGN KEY(session_id)
    REFERENCES experience.chat_sessions(id) ON DELETE CASCADE,
  CONSTRAINT chat_message_likes_message_fkey FOREIGN KEY(message_id)
    REFERENCES experience.chat_history(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_message_likes_message
  ON experience.chat_message_likes(message_id);
ALTER TABLE experience.chat_message_likes OWNER TO postgres;
ALTER TABLE experience.chat_message_likes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_message_likes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON experience.chat_message_likes TO service_role;
COMMENT ON TABLE experience.chat_message_likes IS
  '会话主人对该会话里固定回复版本的个人点赞；分支与原会话独立，仅受限RPC写入，不影响聊天/计费事实。';
COMMENT ON COLUMN experience.chat_message_likes.message_id IS
  '真实chat_history ID；继承回复使用冻结的源ID，新revision不会继承旧点赞。';

-- Append one projection only. Consumers that do not select liked do not need
-- its lookup; a message list reads its feedback in the existing history query.
CREATE OR REPLACE VIEW experience.session_chat_history WITH (security_invoker = true) AS
SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.history,
       h.character_id, h.status, h.upstream_status, h.deduction_rate, h.created_at,
       h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision,
       h.postprocess_version, h.rich_reply_metadata, h.first_token_preview,
       false AS is_inherited,
       EXISTS(SELECT 1 FROM experience.chat_message_likes l
              WHERE l.session_id=h.session_id AND l.message_id=h.id) AS liked
FROM experience.current_chat_history AS h
UNION ALL
SELECT h.id, s.user_id, h.model, h.user_input, h.assistant_reply, h.history,
       s.character_id, h.status, h.upstream_status, NULL::numeric AS deduction_rate, h.created_at,
       h.llm_finish_reason, NULL::uuid AS llm_charge_id, inherited.session_id,
       inherited.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
       NULL::jsonb AS first_token_preview, true AS is_inherited,
       EXISTS(SELECT 1 FROM experience.chat_message_likes l
              WHERE l.session_id=inherited.session_id AND l.message_id=h.id) AS liked
FROM experience.chat_branch_turns AS inherited
JOIN experience.chat_sessions AS s ON s.id = inherited.session_id
JOIN experience.chat_history AS h ON h.id = inherited.source_history_id
  AND h.user_id = s.user_id AND h.character_id = s.character_id
WHERE NOT EXISTS (
  SELECT 1 FROM experience.chat_history AS own
  WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index
);
ALTER VIEW experience.session_chat_history OWNER TO postgres;
REVOKE ALL ON experience.session_chat_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.session_chat_history TO service_role, postgres;
COMMENT ON VIEW experience.session_chat_history IS
  '会话显示与入模投影：本地当前生成优先，其次固定继承引用；liked仅显示使用，分析/计费仍读取原事实。';

CREATE OR REPLACE FUNCTION experience.set_chat_message_like(
  p_user_id uuid, p_session_id uuid, p_message_id uuid, p_liked boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '3s'
SET statement_timeout = '5s'
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR p_message_id IS NULL OR p_liked IS NULL THEN
    RAISE EXCEPTION 'invalid reply like input' USING ERRCODE='22023';
  END IF;

  -- The same session lock as generation prevents a stale visible revision from
  -- acquiring a like while a regeneration changes the current reply identity.
  PERFORM 1 FROM experience.chat_sessions
  WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE='P0002'; END IF;

  PERFORM 1 FROM experience.session_chat_history
  WHERE session_id=p_session_id AND id=p_message_id AND status='success'
    AND btrim(COALESCE(assistant_reply,''))<>'';
  IF NOT FOUND THEN RAISE EXCEPTION 'reply is not a completed current message' USING ERRCODE='P0423'; END IF;

  IF p_liked THEN
    INSERT INTO experience.chat_message_likes(session_id,message_id)
    VALUES(p_session_id,p_message_id) ON CONFLICT(session_id,message_id) DO NOTHING;
  ELSE
    DELETE FROM experience.chat_message_likes WHERE session_id=p_session_id AND message_id=p_message_id;
  END IF;
  RETURN jsonb_build_object('session_id',p_session_id,'message_id',p_message_id,'liked',p_liked);
END;
$fn$;
ALTER FUNCTION experience.set_chat_message_like(uuid,uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.set_chat_message_like(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.set_chat_message_like(uuid,uuid,uuid,boolean) TO service_role, postgres;
COMMENT ON FUNCTION experience.set_chat_message_like(uuid,uuid,uuid,boolean) IS
  '会话主人设置固定可见回复的点赞目标状态；可取消且幂等，软删除/其他用户/失效回复不可写。';

-- The owning domain exposes counts only. Consumers never query its feedback rows
-- or private history, and every explicit like remains one authoritative fact.
CREATE OR REPLACE FUNCTION experience.get_character_reply_like_counts(p_character_ids uuid[])
RETURNS TABLE(character_id uuid,reply_like_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $fn$
BEGIN
  IF p_character_ids IS NULL OR cardinality(p_character_ids) NOT BETWEEN 1 AND 40
     OR array_position(p_character_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid reply like count query' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT s.character_id,count(*)
  FROM experience.chat_message_likes l
  JOIN experience.chat_sessions s ON s.id=l.session_id
  WHERE s.character_id=ANY(p_character_ids)
  GROUP BY s.character_id;
END;
$fn$;
ALTER FUNCTION experience.get_character_reply_like_counts(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.get_character_reply_like_counts(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.get_character_reply_like_counts(uuid[]) TO service_role, postgres;
COMMENT ON FUNCTION experience.get_character_reply_like_counts(uuid[]) IS
  '按最多40个角色批量返回全部手动回复点赞数；含旧版本/独立分支，不返回用户或聊天内容。';

CREATE OR REPLACE FUNCTION miniapp_features.get_character_socials(p_character_ids uuid[],p_user_id uuid)
RETURNS TABLE(character_id uuid,liked boolean,like_count bigint,favorite_count bigint,comment_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_character_ids IS NULL OR cardinality(p_character_ids) NOT BETWEEN 1 AND 40
    OR array_position(p_character_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid social query' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
    EXISTS(SELECT 1 FROM miniapp_features.character_likes l WHERE l.character_id=c.id AND l.user_id=p_user_id),
    (SELECT count(*) FROM miniapp_features.character_likes l WHERE l.character_id=c.id)+COALESCE(r.reply_like_count,0),
    (SELECT count(*) FROM miniapp_features.character_favorites f WHERE f.character_id=c.id),
    (SELECT count(*) FROM miniapp_features.character_comments m WHERE m.character_id=c.id AND m.deleted_at IS NULL)
  FROM app_core.characters c
  LEFT JOIN experience.get_character_reply_like_counts(p_character_ids) r ON r.character_id=c.id
  WHERE c.id=ANY(p_character_ids) AND c.enabled=true AND c.archived_at IS NULL;
END;
$fn$;
-- CREATE OR REPLACE retains the established social function identity and ACL.
COMMENT ON FUNCTION miniapp_features.get_character_socials(uuid[],uuid) IS
  'Service-only bounded aggregate; like_count combines direct card and explicit reply likes, liked remains the viewer direct-card state; no private identities/content.';

COMMIT;
NOTIFY pgrst, 'reload schema';
