-- domain: experience. Read-only display projection and index-key-first pagination.
-- Requires 20261111_chat_history_display_metadata.sql. No backfill/business writes.
-- Roll back Backend readers first; retain these private compatible objects.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Narrow base projection also serves context and current-turn consumers. CASE
-- guards the datum itself, so known NULL fields never evaluate legacy history.
CREATE OR REPLACE VIEW experience.chat_history_display WITH (security_invoker=true) AS
SELECT h.id,h.user_id,h.model,h.user_input,h.assistant_reply,h.character_id,h.status,
 h.upstream_status,h.deduction_rate,h.created_at,h.llm_finish_reason,h.llm_charge_id,
 h.session_id,h.turn_index,h.revision,h.postprocess_version,h.rich_reply_metadata,h.first_token_preview,
 CASE WHEN m.projection_version=1 THEN m.request_id ELSE legacy.request_id END AS display_request_id,
 CASE WHEN m.projection_version=1 THEN m.opening_message ELSE legacy.opening_message END AS display_opening_message,
 m.projection_version IS DISTINCT FROM 1 AS display_fallback
FROM experience.chat_history h
LEFT JOIN experience.chat_history_display_metadata m ON m.history_id=h.id
LEFT JOIN LATERAL experience.extract_chat_history_display(
 CASE WHEN m.projection_version IS DISTINCT FROM 1 THEN h.history END
) legacy ON m.projection_version IS DISTINCT FROM 1;
ALTER VIEW experience.chat_history_display OWNER TO postgres;
REVOKE ALL ON experience.chat_history_display FROM PUBLIC,anon,authenticated;
GRANT SELECT ON experience.chat_history_display TO service_role;

-- Preserve original current-version/branch/override semantics for bounded context
-- and point lookups. The page function below deliberately does NOT paginate this view.
CREATE OR REPLACE VIEW experience.session_chat_display WITH (security_invoker=true) AS
SELECT h.id,h.user_id,h.model,
 CASE WHEN u.deleted THEN '' ELSE COALESCE(u.content,h.user_input) END AS user_input,
 CASE WHEN a.deleted THEN NULL ELSE COALESCE(a.content,h.assistant_reply) END AS assistant_reply,
 h.character_id,h.status,h.upstream_status,h.deduction_rate,h.created_at,h.llm_finish_reason,h.llm_charge_id,
 h.session_id,h.turn_index,h.revision,h.postprocess_version,h.rich_reply_metadata,h.first_token_preview,
 false AS is_inherited,
 EXISTS(SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id=h.session_id AND l.message_id=h.id) AS liked,
 COALESCE(u.deleted,false) AS user_deleted,COALESCE(a.deleted,false) AS assistant_deleted,
 COALESCE(u.version,0) AS user_edit_version,COALESCE(a.version,0) AS assistant_edit_version,
 h.display_request_id,h.display_opening_message,h.display_fallback
FROM experience.chat_history_display h
LEFT JOIN experience.chat_message_overrides u ON u.session_id=h.session_id AND u.message_id=h.id AND u.role='user'
LEFT JOIN experience.chat_message_overrides a ON a.session_id=h.session_id AND a.message_id=h.id AND a.role='assistant'
WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM experience.chat_history newer
   WHERE newer.session_id=h.session_id AND newer.turn_index=h.turn_index AND newer.revision>h.revision)
UNION ALL
SELECT h.id,s.user_id,h.model,
 CASE WHEN u.deleted THEN '' ELSE COALESCE(u.content,h.user_input) END,
 CASE WHEN a.deleted THEN NULL ELSE COALESCE(a.content,h.assistant_reply) END,
 s.character_id,h.status,h.upstream_status,NULL::numeric,h.created_at,h.llm_finish_reason,NULL::uuid,
 b.session_id,b.turn_index,h.revision,h.postprocess_version,h.rich_reply_metadata,NULL::jsonb,true,
 EXISTS(SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id=b.session_id AND l.message_id=h.id),
 COALESCE(u.deleted,false),COALESCE(a.deleted,false),COALESCE(u.version,0),COALESCE(a.version,0),
 NULL::text,h.display_opening_message,h.display_fallback
FROM experience.chat_branch_turns b
JOIN experience.chat_sessions s ON s.id=b.session_id
JOIN experience.chat_history_display h ON h.id=b.source_history_id AND h.user_id=s.user_id AND h.character_id=s.character_id
LEFT JOIN experience.chat_message_overrides u ON u.session_id=b.session_id AND u.message_id=h.id AND u.role='user'
LEFT JOIN experience.chat_message_overrides a ON a.session_id=b.session_id AND a.message_id=h.id AND a.role='assistant'
WHERE NOT EXISTS(SELECT 1 FROM experience.chat_history own WHERE own.session_id=b.session_id AND own.turn_index=b.turn_index);
ALTER VIEW experience.session_chat_display OWNER TO postgres;
REVOKE ALL ON experience.session_chat_display FROM PUBLIC,anon,authenticated;
GRANT SELECT ON experience.session_chat_display TO service_role;

CREATE OR REPLACE FUNCTION experience.list_chat_message_page(
 p_user_id uuid,p_session_id uuid,p_before_turn_index integer DEFAULT NULL,p_turn_limit integer DEFAULT 25
) RETURNS SETOF experience.session_chat_display
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE owner_id uuid; character uuid;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_turn_limit IS NULL OR p_turn_limit<1 OR p_turn_limit>100
   OR (p_before_turn_index IS NOT NULL AND p_before_turn_index<0) THEN
   RAISE EXCEPTION 'invalid chat page arguments' USING ERRCODE='22023';
 END IF;
 SELECT user_id,character_id INTO owner_id,character FROM experience.chat_sessions
 WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE='P0002'; END IF;

 RETURN QUERY
 WITH own_turns AS MATERIALIZED (
   SELECT ch.turn_index FROM experience.chat_history ch
   WHERE ch.session_id=p_session_id AND ch.turn_index IS NOT NULL AND ch.revision IS NOT NULL
     AND ch.turn_index<=COALESCE(p_before_turn_index-1,2147483647)
   GROUP BY ch.turn_index ORDER BY ch.turn_index DESC LIMIT p_turn_limit+1
 ), own_keys AS (
   SELECT latest.id,t.turn_index,false AS inherited FROM own_turns t
   CROSS JOIN LATERAL (SELECT ch.id FROM experience.chat_history ch
     WHERE ch.session_id=p_session_id AND ch.turn_index=t.turn_index AND ch.revision IS NOT NULL
     ORDER BY ch.revision DESC LIMIT 1) latest
 ), branch_keys AS (
   SELECT b.source_history_id AS id,b.turn_index,true AS inherited FROM experience.chat_branch_turns b
   JOIN experience.chat_history source ON source.id=b.source_history_id
     AND source.user_id=owner_id AND source.character_id=character
   WHERE b.session_id=p_session_id AND b.turn_index<=COALESCE(p_before_turn_index-1,2147483647)
     AND NOT EXISTS(SELECT 1 FROM experience.chat_history own
       WHERE own.session_id=p_session_id AND own.turn_index=b.turn_index)
   ORDER BY b.turn_index DESC LIMIT p_turn_limit+1
 ), page_keys AS MATERIALIZED (
   SELECT * FROM (SELECT * FROM own_keys UNION ALL SELECT * FROM branch_keys) candidates
   ORDER BY turn_index DESC LIMIT p_turn_limit+1
 )
 SELECT h.id,CASE WHEN k.inherited THEN owner_id ELSE h.user_id END,h.model,
   CASE WHEN u.deleted THEN '' ELSE COALESCE(u.content,h.user_input) END,
   CASE WHEN a.deleted THEN NULL ELSE COALESCE(a.content,h.assistant_reply) END,
   CASE WHEN k.inherited THEN character ELSE h.character_id END,h.status,h.upstream_status,
   CASE WHEN k.inherited THEN NULL::numeric ELSE h.deduction_rate END,h.created_at,h.llm_finish_reason,
   CASE WHEN k.inherited THEN NULL::uuid ELSE h.llm_charge_id END,p_session_id,k.turn_index,h.revision,
   h.postprocess_version,h.rich_reply_metadata,CASE WHEN k.inherited THEN NULL::jsonb ELSE h.first_token_preview END,
   k.inherited,EXISTS(SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id=p_session_id AND l.message_id=h.id),
   COALESCE(u.deleted,false),COALESCE(a.deleted,false),COALESCE(u.version,0),COALESCE(a.version,0),
   CASE WHEN k.inherited THEN NULL::text ELSE h.display_request_id END,h.display_opening_message,h.display_fallback
 FROM page_keys k JOIN experience.chat_history_display h ON h.id=k.id
 LEFT JOIN experience.chat_message_overrides u ON u.session_id=p_session_id AND u.message_id=h.id AND u.role='user'
 LEFT JOIN experience.chat_message_overrides a ON a.session_id=p_session_id AND a.message_id=h.id AND a.role='assistant'
 ORDER BY k.turn_index DESC;
END;
$fn$;
ALTER FUNCTION experience.list_chat_message_page(uuid,uuid,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.list_chat_message_page(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION experience.list_chat_message_page(uuid,uuid,integer,integer) TO service_role;
COMMENT ON FUNCTION experience.list_chat_message_page(uuid,uuid,integer,integer) IS
 'Private owner-checked cursor page; K+1 logical turns before display hydration; no count/offset/provider joins.';
NOTIFY pgrst,'reload schema';
COMMIT;
