-- 自研引擎会话写入的原子操作（M1）。
--
-- 方案：docs/ST_remove-MVP实施方案.md §5.3 / §5.4 / §5.6。
-- 这两个操作在应用层都是多步写，中间态会违反 uq_chat_messages_active_turn，
-- 因此收进 RPC 由单事务完成。
--
-- 两个函数都以会话行的 FOR UPDATE 作为串行点，顺带解决三件事：
--   1. turn_index / revision 的取最大值再加一不会被并发读到同一个值
--   2. §5.6 的并发保护：同一会话存在未收口的 streaming assistant 行时拒绝新的生成
--   3. 超过 p_stale_after_seconds 未更新的 streaming 行先标记 interrupted 再放行
--
-- SQLSTATE 约定（供 backend 映射到 shared 的 ConversationErrorCode）：
--   P0002 → session_not_found        会话不存在 / 已软删
--   55006 → session_busy             该会话有生成中的回复（HTTP 409）
--   55000 → regenerate_not_allowed   不是最后一轮 / 该轮没有 user 消息
--   22023 → 入参非法

BEGIN;

-- 生成中判定与陈旧流清理。两个 RPC 共用，调用前必须已持有会话行锁。
CREATE OR REPLACE FUNCTION miniapp.guard_chat_session_idle(
  p_session_id UUID,
  p_stale_after_seconds INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE miniapp.chat_messages
  SET status = 'interrupted',
      error_code = COALESCE(error_code, 'stream_stale'),
      updated_at = now()
  WHERE session_id = p_session_id
    AND role = 'assistant'
    AND status = 'streaming'
    AND updated_at < now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1));

  IF EXISTS (
    SELECT 1
    FROM miniapp.chat_messages
    WHERE session_id = p_session_id
      AND role = 'assistant'
      AND status = 'streaming'
  ) THEN
    RAISE EXCEPTION 'chat session % already has a streaming reply', p_session_id
      USING ERRCODE = '55006';
  END IF;
END;
$$;

-- 发消息：算出下一个 turn_index 并落 user 行。
-- 会话的三个冗余字段由 069 的 trg_refresh_chat_session_stats 在同事务内刷新。
CREATE OR REPLACE FUNCTION miniapp.append_chat_turn(
  p_session_id UUID,
  p_user_content TEXT,
  p_stale_after_seconds INTEGER DEFAULT 120
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session miniapp.chat_sessions%ROWTYPE;
  v_turn_index INTEGER;
  v_message_id UUID;
BEGIN
  IF p_session_id IS NULL OR btrim(COALESCE(p_user_content, '')) = '' THEN
    RAISE EXCEPTION 'invalid append_chat_turn input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM miniapp.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM miniapp.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT COALESCE(max(turn_index), -1) + 1 INTO v_turn_index
  FROM miniapp.chat_messages
  WHERE session_id = p_session_id;

  INSERT INTO miniapp.chat_messages (session_id, turn_index, role, content)
  VALUES (p_session_id, v_turn_index, 'user', p_user_content)
  RETURNING id INTO v_message_id;

  RETURN jsonb_build_object(
    'turn_index', v_turn_index,
    'user_message_id', v_message_id
  );
END;
$$;

-- 重生成：只允许最后一轮，且该轮必须有 user 消息（本轮决策 5）。
-- 后一条顺带保证了开场白（turn 0 无 user 行）不可重生成。
-- p_turn_index 传 NULL 表示由服务端取最后一轮；传值时会校验它确实是最后一轮，
-- 用于挡住前端拿着过期轮次发起的重生成。
CREATE OR REPLACE FUNCTION miniapp.start_message_regeneration(
  p_session_id UUID,
  p_turn_index INTEGER DEFAULT NULL,
  p_model_id TEXT DEFAULT NULL,
  p_model_openrouter_id TEXT DEFAULT NULL,
  p_preset_id UUID DEFAULT NULL,
  p_gen_config JSONB DEFAULT NULL,
  p_stale_after_seconds INTEGER DEFAULT 120
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session miniapp.chat_sessions%ROWTYPE;
  v_last_turn INTEGER;
  v_user_content TEXT;
  v_revision INTEGER;
  v_message_id UUID;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'invalid start_message_regeneration input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session
  FROM miniapp.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM miniapp.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT max(turn_index) INTO v_last_turn
  FROM miniapp.chat_messages
  WHERE session_id = p_session_id AND is_active;

  IF v_last_turn IS NULL OR (p_turn_index IS NOT NULL AND p_turn_index <> v_last_turn) THEN
    RAISE EXCEPTION 'only the last turn can be regenerated' USING ERRCODE = '55000';
  END IF;

  SELECT content INTO v_user_content
  FROM miniapp.chat_messages
  WHERE session_id = p_session_id
    AND turn_index = v_last_turn
    AND role = 'user'
    AND is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn % has no user message to regenerate from', v_last_turn
      USING ERRCODE = '55000';
  END IF;

  UPDATE miniapp.chat_messages
  SET is_active = false,
      updated_at = now()
  WHERE session_id = p_session_id
    AND turn_index = v_last_turn
    AND role = 'assistant'
    AND is_active;

  SELECT COALESCE(max(revision), -1) + 1 INTO v_revision
  FROM miniapp.chat_messages
  WHERE session_id = p_session_id
    AND turn_index = v_last_turn
    AND role = 'assistant';

  INSERT INTO miniapp.chat_messages (
    session_id, turn_index, role, revision, is_active, content, status,
    model_id, model_openrouter_id, preset_id, gen_config
  ) VALUES (
    p_session_id, v_last_turn, 'assistant', v_revision, true, '', 'streaming',
    p_model_id, p_model_openrouter_id, p_preset_id, p_gen_config
  )
  RETURNING id INTO v_message_id;

  RETURN jsonb_build_object(
    'turn_index', v_last_turn,
    'assistant_message_id', v_message_id,
    'revision', v_revision,
    'user_content', v_user_content
  );
END;
$$;

REVOKE ALL ON FUNCTION miniapp.guard_chat_session_idle(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.append_chat_turn(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.start_message_regeneration(UUID, INTEGER, TEXT, TEXT, UUID, JSONB, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION miniapp.append_chat_turn(UUID, TEXT, INTEGER)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.start_message_regeneration(UUID, INTEGER, TEXT, TEXT, UUID, JSONB, INTEGER)
  TO service_role, postgres;

COMMIT;

NOTIFY pgrst, 'reload schema';
