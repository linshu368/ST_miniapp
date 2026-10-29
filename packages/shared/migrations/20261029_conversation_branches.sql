-- domain: experience. A branch owns an immutable map to existing completed turns,
-- not new generation/billing facts. Existing current_chat_history remains unchanged.
-- Prerequisites: schema split, context windows, postprocess/reply mode/preview migrations.
-- Local validation: bash scripts/test-conversation-branches-migration.sh
-- Release: TEST migration + read/write/ACL checks, then production migration, Backend, Frontend.
-- Recovery: hide the new UI but retain branch-aware Backend/RPC and branch data.
-- An old Backend cannot read inherited prefixes; after branches exist use a reviewed
-- forward-fix. Never DROP inherited references to roll back UI.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('experience.current_chat_history') IS NULL
     OR to_regprocedure('experience.start_chat_history_turn(uuid,text,text,integer,integer,integer)') IS NULL
     OR to_regprocedure('experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'conversation branching prerequisites are missing';
  END IF;
END
$preflight$;

ALTER TABLE experience.chat_sessions
  ADD COLUMN IF NOT EXISTS branch_source_session_id uuid,
  ADD COLUMN IF NOT EXISTS branch_source_turn_index integer,
  ADD COLUMN IF NOT EXISTS branch_source_message_id uuid,
  ADD COLUMN IF NOT EXISTS branch_inherited_turns integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS branch_request_id uuid;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='experience.chat_sessions'::regclass AND conname='chat_sessions_branch_source_session_fkey') THEN
    ALTER TABLE experience.chat_sessions ADD CONSTRAINT chat_sessions_branch_source_session_fkey
      FOREIGN KEY (branch_source_session_id) REFERENCES experience.chat_sessions(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='experience.chat_sessions'::regclass AND conname='chat_sessions_branch_shape_check') THEN
    ALTER TABLE experience.chat_sessions ADD CONSTRAINT chat_sessions_branch_shape_check CHECK (
      (branch_inherited_turns = 0 AND branch_source_session_id IS NULL AND branch_source_turn_index IS NULL
       AND branch_source_message_id IS NULL AND branch_request_id IS NULL)
      OR (branch_inherited_turns BETWEEN 1 AND 1000 AND branch_source_turn_index IS NOT NULL AND branch_source_turn_index >= 1
          AND branch_source_message_id IS NOT NULL AND branch_request_id IS NOT NULL)
    ) NOT VALID;
  END IF;
END
$constraints$;
ALTER TABLE experience.chat_sessions VALIDATE CONSTRAINT chat_sessions_branch_source_session_fkey;
ALTER TABLE experience.chat_sessions VALIDATE CONSTRAINT chat_sessions_branch_shape_check;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_branch_request
  ON experience.chat_sessions(user_id, branch_request_id) WHERE branch_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_branch_created
  ON experience.chat_sessions(user_id, created_at) WHERE branch_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS experience.chat_branch_turns (
  session_id uuid NOT NULL,
  turn_index integer NOT NULL,
  source_history_id uuid NOT NULL,
  CONSTRAINT chat_branch_turns_pkey PRIMARY KEY(session_id, turn_index),
  CONSTRAINT chat_branch_turns_session_fkey FOREIGN KEY(session_id)
    REFERENCES experience.chat_sessions(id) ON DELETE CASCADE,
  -- Deferred NO ACTION permits full account deletion after its sessions cascade,
  -- but prevents physical pruning of source facts still used by another branch.
  CONSTRAINT chat_branch_turns_source_history_fkey FOREIGN KEY(source_history_id)
    REFERENCES experience.chat_history(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chat_branch_turns_turn_index_check CHECK(turn_index BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS idx_chat_branch_turns_source_history
  ON experience.chat_branch_turns(source_history_id);
ALTER TABLE experience.chat_branch_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.chat_branch_turns OWNER TO postgres;
REVOKE ALL ON experience.chat_branch_turns FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON experience.chat_branch_turns TO service_role;

COMMENT ON TABLE experience.chat_branch_turns IS
  '分支继承轮次的固定引用。源 revision 由 history ID 冻结，不复制生成、prompt 或计费事实；仅 fork_chat_session 写入。';
COMMENT ON COLUMN experience.chat_sessions.branch_inherited_turns IS
  '分支初始继承轮数；局部轮次1..N。后续真实生成从N+1开始，继续使用原上下文高低水位。';
COMMENT ON COLUMN experience.chat_sessions.branch_source_turn_index IS
  '记录所选历史轮次；不参与新会话轮次分配。';
COMMENT ON COLUMN experience.chat_sessions.branch_request_id IS
  '用户范围内分支创建幂等键；丢响应使用同一键恢复，不是生成或扣费标识。';

-- The two UNION legs keep session_id filters pushable. A new local revision wins
-- over an inherited last turn without mutating the source or its current view.
CREATE OR REPLACE VIEW experience.session_chat_history WITH (security_invoker = true) AS
SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.history,
       h.character_id, h.status, h.upstream_status, h.deduction_rate, h.created_at,
       h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision,
       h.postprocess_version, h.rich_reply_metadata, h.first_token_preview,
       false AS is_inherited
FROM experience.current_chat_history AS h
UNION ALL
SELECT h.id, s.user_id, h.model, h.user_input, h.assistant_reply, h.history,
       s.character_id, h.status, h.upstream_status, NULL::numeric AS deduction_rate, h.created_at,
       h.llm_finish_reason, NULL::uuid AS llm_charge_id, inherited.session_id,
       inherited.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
       NULL::jsonb AS first_token_preview, true AS is_inherited
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
  '聊天显示及入模用的当前轮次：本会话当前生成优先，其次固定继承引用。分析与计费继续读取原chat_history/current_chat_history。';

CREATE OR REPLACE FUNCTION experience.fork_chat_session(
  p_user_id uuid, p_source_session_id uuid, p_message_id uuid,
  p_request_id uuid, p_retain_turns integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_source experience.chat_sessions%ROWTYPE;
  v_existing experience.chat_sessions%ROWTYPE;
  v_branch experience.chat_sessions%ROWTYPE;
  v_anchor record;
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_source_session_id IS NULL OR p_message_id IS NULL
     OR p_request_id IS NULL OR p_retain_turns IS NULL OR p_retain_turns NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid branch input' USING ERRCODE = '22023';
  END IF;

  -- Namespace-scoped user lock serializes creation rate/replay without reading
  -- another business domain. Source ownership below also rejects missing users.
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation-branch:' || p_user_id::text, 0));

  SELECT * INTO v_existing FROM experience.chat_sessions
  WHERE user_id = p_user_id AND branch_request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.branch_source_session_id IS DISTINCT FROM p_source_session_id
       OR v_existing.branch_source_message_id IS DISTINCT FROM p_message_id THEN
      RAISE EXCEPTION 'branch request identity conflict' USING ERRCODE = 'P0409';
    END IF;
    IF v_existing.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'branch no longer available' USING ERRCODE = 'P0422';
    END IF;
    RETURN to_jsonb(v_existing);
  END IF;

  SELECT * INTO v_source FROM experience.chat_sessions
  WHERE id = p_source_session_id AND user_id = p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE = 'P0002'; END IF;

  SELECT turn_index, assistant_reply INTO v_anchor FROM experience.session_chat_history
  WHERE session_id = p_source_session_id AND id = p_message_id
    AND status = 'success' AND btrim(COALESCE(assistant_reply, '')) <> '';
  IF NOT FOUND THEN RAISE EXCEPTION 'branch message is not a completed current reply' USING ERRCODE = 'P0422'; END IF;

  IF (SELECT count(*) FROM experience.chat_sessions
      WHERE user_id = p_user_id AND branch_request_id IS NOT NULL
        AND created_at >= now() - interval '1 minute') >= 10 THEN
    RAISE EXCEPTION 'branch creation rate exceeded' USING ERRCODE = 'P0429';
  END IF;

  INSERT INTO experience.chat_sessions (
    user_id, character_id, title, branch_source_session_id, branch_source_turn_index,
    branch_source_message_id, branch_inherited_turns, branch_request_id,
    message_count, last_message_at, last_message_preview
  ) VALUES (
    p_user_id, v_source.character_id,
    '分支 · ' || left(regexp_replace(COALESCE(NULLIF(btrim(v_source.title), ''), '新的对话'), '^分支 · ', ''), 55),
    p_source_session_id, v_anchor.turn_index, p_message_id, 1, p_request_id,
    0, now(), left(btrim(regexp_replace(v_anchor.assistant_reply, '\s+', ' ', 'g')), 120)
  ) RETURNING * INTO v_branch;

  INSERT INTO experience.chat_branch_turns(session_id, turn_index, source_history_id)
  SELECT v_branch.id, row_number() OVER (ORDER BY picked.turn_index)::integer, picked.id
  FROM (
    SELECT id, turn_index FROM experience.session_chat_history
    WHERE session_id = p_source_session_id AND turn_index <= v_anchor.turn_index
    ORDER BY turn_index DESC LIMIT p_retain_turns
  ) AS picked;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count < 1 THEN RAISE EXCEPTION 'branch has no context' USING ERRCODE = 'P0422'; END IF;

  UPDATE experience.chat_sessions SET branch_inherited_turns = v_count,
    message_count = v_count * 2 WHERE id = v_branch.id RETURNING * INTO v_branch;
  RETURN to_jsonb(v_branch);
END;
$fn$;
ALTER FUNCTION experience.fork_chat_session(uuid,uuid,uuid,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.fork_chat_session(uuid,uuid,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.fork_chat_session(uuid,uuid,uuid,uuid,integer) TO service_role, postgres;

-- Existing orchestration wrappers, generation billing and statement identities
-- remain intact; only turn allocation/user input source learn inherited rounds.
CREATE OR REPLACE FUNCTION experience.start_chat_history_turn(
  p_session_id UUID,
  p_user_content TEXT,
  p_model TEXT,
  p_stale_after_seconds INTEGER DEFAULT 120,
  p_max_context_turns INTEGER DEFAULT 75,
  p_retain_context_turns INTEGER DEFAULT 50
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session experience.chat_sessions%ROWTYPE;
  v_turn_index INTEGER;
  v_history_id UUID;
  v_window_start INTEGER;
BEGIN
  IF p_session_id IS NULL
     OR btrim(COALESCE(p_user_content, '')) = ''
     OR btrim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'invalid start_chat_history_turn input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM experience.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM experience.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT COALESCE(max(turn_index), 0) + 1 INTO v_turn_index
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index IS NOT NULL;

  v_turn_index := GREATEST(v_turn_index, v_session.branch_inherited_turns + 1);

  v_window_start := experience.apply_context_window_flood(
    p_session_id,
    v_turn_index - 1,
    v_session.context_window_start_turn,
    p_max_context_turns,
    p_retain_context_turns
  );

  INSERT INTO experience.chat_history (
    user_id, model, user_input, assistant_reply, history, character_id,
    status, session_id, turn_index, revision
  ) VALUES (
    v_session.user_id, p_model, p_user_content, NULL, '[]'::jsonb, v_session.character_id,
    'streaming', p_session_id, v_turn_index, 0
  )
  RETURNING id INTO v_history_id;

  RETURN jsonb_build_object(
    'turn_index', v_turn_index,
    'history_id', v_history_id,
    'revision', 0,
    'context_window_start_turn', v_window_start
  );
END;
$$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration(
  p_session_id UUID,
  p_turn_index INTEGER DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
  p_stale_after_seconds INTEGER DEFAULT 120,
  p_max_context_turns INTEGER DEFAULT 75,
  p_retain_context_turns INTEGER DEFAULT 50
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session experience.chat_sessions%ROWTYPE;
  v_last_turn INTEGER;
  v_user_content TEXT;
  v_revision INTEGER;
  v_history_id UUID;
  v_window_start INTEGER;
BEGIN
  IF p_session_id IS NULL OR btrim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'invalid start_chat_history_regeneration input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM experience.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM experience.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT GREATEST(COALESCE(max(turn_index), 0), v_session.branch_inherited_turns) INTO v_last_turn
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index IS NOT NULL;

  IF v_last_turn < 1 OR (p_turn_index IS NOT NULL AND p_turn_index <> v_last_turn) THEN
    RAISE EXCEPTION 'only the last turn can be regenerated' USING ERRCODE = '55000';
  END IF;

  SELECT user_input, revision INTO v_user_content, v_revision
  FROM experience.session_chat_history
  WHERE session_id = p_session_id AND turn_index = v_last_turn
  ORDER BY revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn % has no user input to regenerate from', v_last_turn
      USING ERRCODE = '55000';
  END IF;

  v_window_start := experience.apply_context_window_flood(
    p_session_id,
    v_last_turn - 1,
    v_session.context_window_start_turn,
    p_max_context_turns,
    p_retain_context_turns
  );

  SELECT GREATEST(COALESCE(max(revision), -1), v_revision) + 1 INTO v_revision
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index = v_last_turn;

  INSERT INTO experience.chat_history (
    user_id, model, user_input, assistant_reply, history, character_id,
    status, session_id, turn_index, revision
  ) VALUES (
    v_session.user_id, p_model, v_user_content, NULL, '[]'::jsonb, v_session.character_id,
    'streaming', p_session_id, v_last_turn, v_revision
  )
  RETURNING id INTO v_history_id;

  RETURN jsonb_build_object(
    'turn_index', v_last_turn,
    'history_id', v_history_id,
    'revision', v_revision,
    'user_content', v_user_content,
    'context_window_start_turn', v_window_start
  );
END;
$$;

ALTER FUNCTION experience.start_chat_history_turn(uuid,text,text,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.start_chat_history_turn(uuid,text,text,integer,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn(uuid,text,text,integer,integer,integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer) TO service_role, postgres;

CREATE OR REPLACE FUNCTION experience.tf_refresh_chat_session_stats_from_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_session_id uuid := NEW.session_id;
BEGIN
  IF v_session_id IS NULL THEN RETURN NULL; END IF;
  UPDATE experience.chat_sessions AS s
  SET message_count = stats.turn_count * 2, last_message_at = stats.last_at,
      last_message_preview = stats.preview, updated_at = now()
  FROM (
    WITH current_turns AS (
      SELECT turn_index, user_input, assistant_reply, created_at
      FROM experience.session_chat_history WHERE session_id = v_session_id
    )
    SELECT count(*)::integer AS turn_count, max(created_at) AS last_at,
      (SELECT left(btrim(regexp_replace(COALESCE(NULLIF(assistant_reply, ''), user_input), '\s+', ' ', 'g')), 120)
       FROM current_turns ORDER BY turn_index DESC LIMIT 1) AS preview
    FROM current_turns
  ) AS stats WHERE s.id = v_session_id;
  RETURN NULL;
END;
$fn$;
ALTER FUNCTION experience.tf_refresh_chat_session_stats_from_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.tf_refresh_chat_session_stats_from_history() FROM PUBLIC, anon, authenticated;

-- Existing wrappers use the preceding real generation's diagnostic. At an
-- inherited boundary that SELECT has no row; normalize its NULL to the same
-- conservative full mode used for missing metadata on an existing row.
DO $wrapper_null_guard$
DECLARE signature text; definition text; changed text; matches integer; fixed_matches integer; before_acl jsonb; after_acl jsonb;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
    'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'
  ] LOOP
    SELECT pg_get_functiondef(p.oid), jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig)
      INTO definition,before_acl FROM pg_proc p WHERE p.oid=to_regprocedure(signature);
    IF definition IS NULL THEN RAISE EXCEPTION 'current postprocess wrapper missing'; END IF;
    matches := (length(definition)-length(replace(definition, 'OR NOT v_previous_exact','')))/length('OR NOT v_previous_exact');
    fixed_matches := (length(definition)-length(replace(definition, 'OR NOT COALESCE(v_previous_exact, false)','')))/length('OR NOT COALESCE(v_previous_exact, false)');
    IF NOT ((matches=1 AND fixed_matches=0) OR (matches=0 AND fixed_matches=1)) THEN
      RAISE EXCEPTION 'ambiguous current postprocess wrapper adaptation';
    END IF;
    changed := replace(definition, 'OR NOT v_previous_exact', 'OR NOT COALESCE(v_previous_exact, false)');
    IF changed = definition AND position('OR NOT COALESCE(v_previous_exact, false)' in definition)=0 THEN
      RAISE EXCEPTION 'current postprocess wrapper shape changed; review branch boundary adaptation';
    END IF;
    IF changed <> definition THEN EXECUTE changed; END IF;
    SELECT jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig)
      INTO after_acl FROM pg_proc p WHERE p.oid=to_regprocedure(signature);
    IF before_acl IS DISTINCT FROM after_acl THEN RAISE EXCEPTION 'current postprocess wrapper identity or privileges changed'; END IF;
  END LOOP;
END
$wrapper_null_guard$;

COMMIT;
NOTIFY pgrst, 'reload schema';
