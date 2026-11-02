-- domain: experience. Per-conversation message presentation/context overrides.
-- Generated history, billing and existing branch snapshots stay immutable.
-- Apply after 20261029_chat_message_likes.sql; TEST first, then Backend -> Frontend.
-- Recovery: disable editing UI; retain this view/table. Do not restore deleted text
-- through an old view. Forward-fix after any writes. No production execution here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS experience.chat_message_overrides (
  session_id uuid NOT NULL REFERENCES experience.chat_sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text,
  deleted boolean NOT NULL DEFAULT false,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,message_id,role),
  CHECK ((deleted AND content IS NULL) OR (NOT deleted AND btrim(content)<>'' AND content IS NOT NULL)),
  CHECK (content IS NULL OR length(content)<=CASE WHEN role='user' THEN 8000 ELSE 65536 END)
);
CREATE INDEX IF NOT EXISTS idx_chat_message_overrides_message ON experience.chat_message_overrides(message_id);
ALTER TABLE experience.chat_message_overrides OWNER TO postgres;
ALTER TABLE experience.chat_message_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_message_overrides FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON experience.chat_message_overrides TO service_role;
COMMENT ON TABLE experience.chat_message_overrides IS '会话局部编辑/单条删除；原生成与扣费事实不变，新分支冻结覆盖，只有受限RPC写入';
CREATE OR REPLACE VIEW experience.session_chat_history WITH (security_invoker = true) AS
SELECT h.id, h.user_id, h.model, CASE WHEN u.deleted THEN '' ELSE COALESCE(u.content,h.user_input) END AS user_input,
       CASE WHEN a.deleted THEN NULL ELSE COALESCE(a.content,h.assistant_reply) END AS assistant_reply, h.history,
       h.character_id, h.status, h.upstream_status, h.deduction_rate, h.created_at,
       h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision,
       h.postprocess_version, h.rich_reply_metadata, h.first_token_preview,
       false AS is_inherited,
       EXISTS(SELECT 1 FROM experience.chat_message_likes l
              WHERE l.session_id=h.session_id AND l.message_id=h.id) AS liked,
       COALESCE(u.deleted,false) AS user_deleted, COALESCE(a.deleted,false) AS assistant_deleted,
       COALESCE(u.version,0) AS user_edit_version, COALESCE(a.version,0) AS assistant_edit_version
FROM experience.current_chat_history AS h
LEFT JOIN experience.chat_message_overrides u ON u.session_id=h.session_id AND u.message_id=h.id AND u.role='user'
LEFT JOIN experience.chat_message_overrides a ON a.session_id=h.session_id AND a.message_id=h.id AND a.role='assistant'
UNION ALL
SELECT h.id, s.user_id, h.model, CASE WHEN u.deleted THEN '' ELSE COALESCE(u.content,h.user_input) END AS user_input,
       CASE WHEN a.deleted THEN NULL ELSE COALESCE(a.content,h.assistant_reply) END AS assistant_reply, h.history,
       s.character_id, h.status, h.upstream_status, NULL::numeric AS deduction_rate, h.created_at,
       h.llm_finish_reason, NULL::uuid AS llm_charge_id, inherited.session_id,
       inherited.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
       NULL::jsonb AS first_token_preview, true AS is_inherited,
       EXISTS(SELECT 1 FROM experience.chat_message_likes l
              WHERE l.session_id=inherited.session_id AND l.message_id=h.id) AS liked,
       COALESCE(u.deleted,false) AS user_deleted, COALESCE(a.deleted,false) AS assistant_deleted,
       COALESCE(u.version,0) AS user_edit_version, COALESCE(a.version,0) AS assistant_edit_version
FROM experience.chat_branch_turns AS inherited
JOIN experience.chat_sessions AS s ON s.id = inherited.session_id
JOIN experience.chat_history AS h ON h.id = inherited.source_history_id
  AND h.user_id = s.user_id AND h.character_id = s.character_id
LEFT JOIN experience.chat_message_overrides u ON u.session_id=inherited.session_id AND u.message_id=h.id AND u.role='user'
LEFT JOIN experience.chat_message_overrides a ON a.session_id=inherited.session_id AND a.message_id=h.id AND a.role='assistant'
WHERE NOT EXISTS (
  SELECT 1 FROM experience.chat_history AS own
  WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index
);

ALTER VIEW experience.session_chat_history OWNER TO postgres;
REVOKE ALL ON experience.session_chat_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON experience.session_chat_history TO service_role,postgres;

CREATE OR REPLACE FUNCTION experience.change_chat_message(
 p_user_id uuid,p_session_id uuid,p_message_id uuid,p_role text,p_action text,
 p_expected_version integer,p_content text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
SET lock_timeout='3s' SET statement_timeout='5s' AS $fn$
DECLARE v_turn integer; v_last integer; v_version integer; v_old_content text;
 v_deleted boolean; v_new_deleted boolean := p_action='delete'; v_result jsonb;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_message_id IS NULL
  OR p_role IS NULL OR p_role NOT IN ('user','assistant')
  OR p_action IS NULL OR p_action NOT IN ('edit','delete')
  OR p_expected_version IS NULL OR p_expected_version<0
  OR (p_action='edit' AND (p_content IS NULL OR btrim(p_content)='' OR length(p_content)>CASE WHEN p_role='user' THEN 8000 ELSE 65536 END))
  OR (p_action='delete' AND p_content IS NOT NULL) THEN
  RAISE EXCEPTION 'invalid message change' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM experience.chat_sessions WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE='P0002'; END IF;
 -- Never modify a prompt while its generation is running. Same lock as start/fork.
 IF EXISTS(SELECT 1 FROM experience.chat_history WHERE session_id=p_session_id AND status='streaming') THEN
  RAISE EXCEPTION 'chat session busy' USING ERRCODE='55006';
 END IF;
 SELECT max(turn_index) INTO v_last FROM experience.session_chat_history WHERE session_id=p_session_id;
 SELECT turn_index,CASE WHEN p_role='user' THEN user_input ELSE assistant_reply END,
  CASE WHEN p_role='user' THEN user_deleted ELSE assistant_deleted END,
  CASE WHEN p_role='user' THEN user_edit_version ELSE assistant_edit_version END
 INTO v_turn,v_old_content,v_deleted,v_version FROM experience.session_chat_history
 WHERE session_id=p_session_id AND id=p_message_id AND status<>'streaming';
 IF NOT FOUND OR v_turn<greatest(1,v_last-9) THEN
  RAISE EXCEPTION 'only latest ten rounds can change' USING ERRCODE='P0424';
 END IF;
 -- Target-state replay is safe after a response is lost; a competing edit is not.
 IF v_version=p_expected_version+1 AND v_deleted=v_new_deleted
   AND (v_new_deleted OR v_old_content=p_content) THEN
  RETURN jsonb_build_object('session_id',p_session_id,'message_id',p_message_id,'role',p_role,
    'content',COALESCE(v_old_content,''),'deleted',v_deleted,'edit_version',v_version);
 END IF;
 IF v_version<>p_expected_version OR v_deleted THEN
  RAISE EXCEPTION 'message changed since editor opened' USING ERRCODE='P0425';
 END IF;
 INSERT INTO experience.chat_message_overrides(session_id,message_id,role,content,deleted,version)
 VALUES(p_session_id,p_message_id,p_role,CASE WHEN v_new_deleted THEN NULL ELSE p_content END,v_new_deleted,v_version+1)
 ON CONFLICT(session_id,message_id,role) DO UPDATE SET content=excluded.content,deleted=excluded.deleted,
  version=excluded.version,updated_at=now();
 -- Preview changes only when this is the last remaining visible message.
 UPDATE experience.chat_sessions SET updated_at=now(),
  message_count=(SELECT sum((NOT user_deleted)::integer+(NOT assistant_deleted)::integer) FROM experience.session_chat_history WHERE session_id=p_session_id),
  last_message_preview=(SELECT left(regexp_replace(CASE WHEN NOT assistant_deleted AND COALESCE(assistant_reply,'')<>'' THEN assistant_reply ELSE user_input END,'\s+',' ','g'),120)
    FROM experience.session_chat_history WHERE session_id=p_session_id AND (NOT user_deleted OR NOT assistant_deleted)
    ORDER BY turn_index DESC LIMIT 1)
 WHERE id=p_session_id;
 RETURN jsonb_build_object('session_id',p_session_id,'message_id',p_message_id,'role',p_role,
   'content',CASE WHEN v_new_deleted THEN '' ELSE p_content END,'deleted',v_new_deleted,'edit_version',v_version+1);
END $fn$;
ALTER FUNCTION experience.change_chat_message(uuid,uuid,uuid,text,text,integer,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.change_chat_message(uuid,uuid,uuid,text,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION experience.change_chat_message(uuid,uuid,uuid,text,text,integer,text) TO service_role,postgres;

-- Preserve any upstream additions (e.g. character version snapshots). Fail closed
-- if the insertion point changes rather than replacing the whole function.
DO $patch$
DECLARE v_src text; v_anchor text; v_add text;
BEGIN
 SELECT pg_get_functiondef('experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)'::regprocedure) INTO v_src;
 v_anchor := 'GET DIAGNOSTICS v_count = ROW_COUNT;';
 v_add := $copy$
  -- Freeze message overrides with the inherited history references.
  INSERT INTO experience.chat_message_overrides(session_id,message_id,role,content,deleted,version,updated_at)
  SELECT v_branch.id,o.message_id,o.role,o.content,o.deleted,o.version,o.updated_at
  FROM experience.chat_message_overrides o
  JOIN experience.chat_branch_turns b ON b.session_id=v_branch.id AND b.source_history_id=o.message_id
  WHERE o.session_id=p_source_session_id;
$copy$;
 IF position('Freeze message overrides' IN v_src)=0 THEN
  IF position(v_anchor IN v_src)=0 THEN RAISE EXCEPTION 'fork patch anchor changed'; END IF;
  EXECUTE replace(v_src,v_anchor,v_anchor||v_add);
 END IF;
 SELECT pg_get_functiondef('experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)'::regprocedure) INTO v_src;
 IF position('message_count = v_count * 2' IN v_src)>0 THEN
  EXECUTE replace(v_src,'message_count = v_count * 2','message_count = (SELECT sum((NOT user_deleted)::integer+(NOT assistant_deleted)::integer) FROM experience.session_chat_history WHERE session_id=v_branch.id)');
 END IF;
 SELECT pg_get_functiondef('experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)'::regprocedure) INTO v_src;
 v_anchor := 'IF NOT FOUND THEN'||chr(10)||'    RAISE EXCEPTION ''turn % has no user input';
 IF position('IF NOT FOUND OR btrim(COALESCE(v_user_content' IN v_src)=0 THEN
  IF position(v_anchor IN v_src)=0 THEN RAISE EXCEPTION 'regeneration patch anchor changed'; END IF;
  EXECUTE replace(v_src,v_anchor,$guard$IF NOT FOUND OR btrim(COALESCE(v_user_content, '')) = '' THEN$guard$||chr(10)||'    RAISE EXCEPTION ''turn % has no user input');
 END IF;
END $patch$;
CREATE OR REPLACE FUNCTION experience.tf_refresh_chat_session_stats_from_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_session_id uuid := NEW.session_id;
BEGIN
  IF v_session_id IS NULL THEN RETURN NULL; END IF;
  UPDATE experience.chat_sessions AS s
  SET message_count = stats.message_count, last_message_at = stats.last_at,
      last_message_preview = stats.preview, updated_at = now()
  FROM (
    WITH current_turns AS (
      SELECT turn_index, user_input, assistant_reply, created_at, user_deleted, assistant_deleted
      FROM experience.session_chat_history WHERE session_id = v_session_id
    )
    SELECT COALESCE(sum((NOT user_deleted)::integer+(NOT assistant_deleted)::integer),0)::integer AS message_count, max(created_at) AS last_at,
      (SELECT left(btrim(regexp_replace(COALESCE(NULLIF(assistant_reply, ''), user_input), '\s+', ' ', 'g')), 120)
       FROM current_turns WHERE NOT user_deleted OR NOT assistant_deleted ORDER BY turn_index DESC LIMIT 1) AS preview
    FROM current_turns
  ) AS stats WHERE s.id = v_session_id;
  RETURN NULL;
END;
$fn$;

NOTIFY pgrst,'reload schema';
COMMIT;
