-- domain: experience. Private reply feedback, not public comments or rating inputs.
-- Prerequisite: 20261102_chat_message_overrides.sql and its session_chat_history view.
-- Verify: bash scripts/test-conversation-branches-migration.sh
-- Release: TEST -> production migration -> Backend -> Frontend.
-- Recovery: revert applications, retain private feedback; never DROP collected data.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $preflight$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('experience.session_chat_history') AND attname='assistant_edit_version') THEN
  RAISE EXCEPTION 'feedback requires edited and inherited session history projection';
 END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS experience.chat_reply_feedback (
 id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT chat_reply_feedback_pkey PRIMARY KEY,
 user_id uuid NOT NULL CONSTRAINT chat_reply_feedback_user_fkey REFERENCES app_core.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 message_id uuid NOT NULL,
 edit_version integer NOT NULL CONSTRAINT chat_reply_feedback_edit_version_check CHECK(edit_version>=0),
 character_id uuid NOT NULL,
 turn_index integer NOT NULL,
 revision integer NOT NULL,
 is_inherited boolean NOT NULL,
 model_id text NOT NULL,
 provider text,
 provider_model_id text,
 user_input text NOT NULL,
 assistant_reply text NOT NULL,
 reasons text[] NOT NULL DEFAULT '{}',
 detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT chat_reply_feedback_target_key UNIQUE(session_id,message_id,edit_version),
 CONSTRAINT chat_reply_feedback_detail_check CHECK(char_length(detail)<=500),
 CONSTRAINT chat_reply_feedback_reasons_check CHECK(cardinality(reasons)<=8 AND array_position(reasons,NULL) IS NULL AND reasons <@ ARRAY['out_of_character','controls_player','lacks_tension','ignores_instructions','repetitive','dull_plot','slow_or_error','other']::text[])
);
CREATE INDEX IF NOT EXISTS chat_reply_feedback_created_idx ON experience.chat_reply_feedback(created_at,id);
CREATE INDEX IF NOT EXISTS chat_reply_feedback_user_created_idx ON experience.chat_reply_feedback(user_id,created_at);
ALTER TABLE experience.chat_reply_feedback OWNER TO postgres;
ALTER TABLE experience.chat_reply_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_reply_feedback FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON experience.chat_reply_feedback TO service_role;
COMMENT ON TABLE experience.chat_reply_feedback IS '私有角色回复负反馈；同一会话/固定回复/编辑版本一条，空原因有效；不影响角色分数或计费。';
COMMENT ON COLUMN experience.chat_reply_feedback.assistant_reply IS '首次反馈时后端读取的可见回复快照，包含当时编辑；后续编辑/删会话不改写此证据。';
COMMENT ON COLUMN experience.chat_reply_feedback.user_input IS '首次反馈时同轮用户输入，不复制整个prompt或思考过程。';
COMMENT ON COLUMN experience.chat_reply_feedback.session_id IS '授权RPC校验来源；无session/history FK以保留删会话后的反馈。删除用户时级联清理。';
COMMENT ON COLUMN experience.chat_reply_feedback.provider IS '原生成计费快照中的供应商；历史缺失保留NULL，不猜测。';
COMMENT ON COLUMN experience.chat_reply_feedback.reasons IS '稳定原因代码，展示名称来自shared CHAT_FEEDBACK_REASONS；空数组表示未选原因的有效负反馈。';

CREATE OR REPLACE FUNCTION experience.get_chat_reply_feedback(p_user_id uuid,p_session_id uuid,p_message_id uuid,p_edit_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
SET statement_timeout='5s' AS $fn$
DECLARE v_result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM experience.chat_sessions WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL) THEN
  RAISE EXCEPTION 'session not found' USING ERRCODE='P0002';
 END IF;
 SELECT jsonb_build_object('id',id,'session_id',session_id,'message_id',message_id,'edit_version',edit_version,
  'reasons',reasons,'detail',detail,'created_at',created_at,'updated_at',updated_at)
 INTO v_result FROM experience.chat_reply_feedback
 WHERE user_id=p_user_id AND session_id=p_session_id AND message_id=p_message_id AND edit_version=p_edit_version;
 RETURN jsonb_build_object('feedback',v_result);
END $fn$;

CREATE OR REPLACE FUNCTION experience.save_chat_reply_feedback(
 p_user_id uuid,p_session_id uuid,p_message_id uuid,p_expected_version integer,p_reasons text[],p_detail text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
SET lock_timeout='3s' SET statement_timeout='5s' AS $fn$
DECLARE v_row record; v_feedback experience.chat_reply_feedback; v_reasons text[];
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_message_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0
  OR p_reasons IS NULL OR cardinality(p_reasons)>8 OR array_position(p_reasons,NULL) IS NOT NULL
  OR NOT(p_reasons <@ ARRAY['out_of_character','controls_player','lacks_tension','ignores_instructions','repetitive','dull_plot','slow_or_error','other']::text[])
  OR p_detail IS NULL OR char_length(p_detail)>500 THEN
  RAISE EXCEPTION 'invalid feedback input' USING ERRCODE='22023';
 END IF;
 SELECT COALESCE(array_agg(reason ORDER BY reason),'{}'::text[]) INTO v_reasons FROM (SELECT DISTINCT unnest(p_reasons) AS reason) t;
 PERFORM pg_advisory_xact_lock(hashtextextended('chat-feedback:'||p_user_id::text,0));
 -- Short owner lock serializes submissions and agrees with edit/regeneration locking.
 PERFORM 1 FROM experience.chat_sessions WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_feedback FROM experience.chat_reply_feedback WHERE session_id=p_session_id AND message_id=p_message_id AND edit_version=p_expected_version AND user_id=p_user_id;
 IF FOUND THEN
  -- Replay after a lost response keeps first evidence and timestamps stable.
  IF v_feedback.reasons IS DISTINCT FROM v_reasons OR v_feedback.detail IS DISTINCT FROM btrim(p_detail) THEN
   UPDATE experience.chat_reply_feedback SET reasons=v_reasons,detail=btrim(p_detail),updated_at=now()
   WHERE id=v_feedback.id RETURNING * INTO v_feedback;
  END IF;
 ELSE
  SELECT h.*,raw.llm_billing_snapshot INTO v_row
  FROM experience.session_chat_history h JOIN experience.chat_history raw ON raw.id=h.id
  WHERE h.session_id=p_session_id AND h.id=p_message_id AND h.user_id=p_user_id
    AND h.status='success' AND NOT h.assistant_deleted AND btrim(COALESCE(h.assistant_reply,''))<>''
    AND h.assistant_edit_version=p_expected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'reply changed or unavailable' USING ERRCODE='P0426'; END IF;
  IF (SELECT count(*) FROM experience.chat_reply_feedback WHERE user_id=p_user_id AND created_at>now()-interval '1 minute')>=30 THEN
   RAISE EXCEPTION 'too many feedback entries' USING ERRCODE='P0429';
  END IF;
  INSERT INTO experience.chat_reply_feedback(user_id,session_id,message_id,edit_version,character_id,turn_index,revision,is_inherited,
   model_id,provider,provider_model_id,user_input,assistant_reply,reasons,detail)
  VALUES(p_user_id,p_session_id,p_message_id,p_expected_version,v_row.character_id,v_row.turn_index,v_row.revision,v_row.is_inherited,
   v_row.model,v_row.llm_billing_snapshot->>'provider',v_row.llm_billing_snapshot->>'provider_model_id',v_row.user_input,v_row.assistant_reply,v_reasons,btrim(p_detail))
  RETURNING * INTO v_feedback;
 END IF;
 RETURN jsonb_build_object('feedback',jsonb_build_object('id',v_feedback.id,'session_id',v_feedback.session_id,'message_id',v_feedback.message_id,
  'edit_version',v_feedback.edit_version,'reasons',v_feedback.reasons,'detail',v_feedback.detail,'created_at',v_feedback.created_at,'updated_at',v_feedback.updated_at));
END $fn$;
ALTER FUNCTION experience.get_chat_reply_feedback(uuid,uuid,uuid,integer) OWNER TO postgres;
ALTER FUNCTION experience.save_chat_reply_feedback(uuid,uuid,uuid,integer,text[],text) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.get_chat_reply_feedback(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION experience.save_chat_reply_feedback(uuid,uuid,uuid,integer,text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION experience.get_chat_reply_feedback(uuid,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION experience.save_chat_reply_feedback(uuid,uuid,uuid,integer,text[],text) TO service_role;
DO $verify$ BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='experience.chat_reply_feedback'::regclass)
  OR has_table_privilege('anon','experience.chat_reply_feedback','SELECT')
  OR has_table_privilege('authenticated','experience.chat_reply_feedback','SELECT')
  OR has_table_privilege('service_role','experience.chat_reply_feedback','INSERT')
  OR has_function_privilege('anon','experience.save_chat_reply_feedback(uuid,uuid,uuid,integer,text[],text)','EXECUTE') THEN
  RAISE EXCEPTION 'feedback permission verification failed';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='experience.chat_reply_feedback'::regclass AND conname='chat_reply_feedback_target_key' AND contype='u') THEN
  RAISE EXCEPTION 'feedback idempotency constraint missing';
 END IF;
END $verify$;
NOTIFY pgrst,'reload schema';
COMMIT;
