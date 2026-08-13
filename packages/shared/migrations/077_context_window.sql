-- 自研引擎上下文水位线泄洪：
--   1) chat_sessions.context_window_start_turn 记住入模窗口起点
--   2) runtime_config 双水位 A/B（retain / max）
--   3) 开轮 RPC 在会话行锁内按 A/B 更新起点；不删 chat_history
--
-- 窗口按轮计数。开场白是虚拟 turn 0，不计入水位、始终入模。
-- 详见 docs/context-window-and-prompt-cache.md。

BEGIN;

ALTER TABLE miniapp.chat_sessions
  ADD COLUMN IF NOT EXISTS context_window_start_turn INTEGER NOT NULL DEFAULT 1;

ALTER TABLE miniapp.chat_sessions
  DROP CONSTRAINT IF EXISTS chat_sessions_context_window_start_turn_check;

ALTER TABLE miniapp.chat_sessions
  ADD CONSTRAINT chat_sessions_context_window_start_turn_check
    CHECK (context_window_start_turn >= 1);

COMMENT ON COLUMN miniapp.chat_sessions.context_window_start_turn IS
  '入模历史下界（含）：从该 turn_index 起到本轮之前。默认 1=尚未泄洪。只在窗口超过 max_context_turns 时跳到 retain_context_turns。';

INSERT INTO miniapp.runtime_config (
  key, value, description, version, updated_at, text_value
) VALUES (
  'max_context_turns',
  '75'::JSONB,
  '自研引擎入模历史高水位 B：最多带最近 B 轮。超过后一次性收到低水位 A。',
  1,
  now(),
  NULL
), (
  'retain_context_turns',
  '50'::JSONB,
  '自研引擎入模历史低水位 A：泄洪后留下最近 A 轮。须 1 ≤ A ≤ B，A 应明显小于 B 以保住 prompt cache。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

-- 内部：在已持有 chat_sessions 行锁的调用方里，必要时把窗口起点跳到「只留最近 A 轮」。
CREATE OR REPLACE FUNCTION miniapp.apply_context_window_flood(
  p_session_id UUID,
  p_completed_turns INTEGER,
  p_current_start INTEGER,
  p_max_turns INTEGER,
  p_retain_turns INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_max INTEGER;
  v_retain INTEGER;
  v_start INTEGER;
  v_size INTEGER;
BEGIN
  v_max := GREATEST(COALESCE(p_max_turns, 75), 1);
  v_retain := GREATEST(COALESCE(p_retain_turns, 50), 1);
  IF v_retain > v_max THEN
    v_retain := v_max;
  END IF;

  v_start := GREATEST(COALESCE(p_current_start, 1), 1);
  v_size := p_completed_turns - v_start + 1;

  IF p_completed_turns > 0 AND v_size > v_max THEN
    v_start := p_completed_turns - v_retain + 1;
    UPDATE miniapp.chat_sessions
    SET context_window_start_turn = v_start
    WHERE id = p_session_id;
  END IF;

  RETURN v_start;
END;
$$;

DROP FUNCTION IF EXISTS miniapp.start_chat_history_turn(UUID, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS miniapp.start_chat_history_regeneration(UUID, INTEGER, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION miniapp.start_chat_history_turn(
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
  v_session miniapp.chat_sessions%ROWTYPE;
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
  FROM miniapp.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM miniapp.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT COALESCE(max(turn_index), 0) + 1 INTO v_turn_index
  FROM miniapp.chat_history
  WHERE session_id = p_session_id AND turn_index IS NOT NULL;

  v_window_start := miniapp.apply_context_window_flood(
    p_session_id,
    v_turn_index - 1,
    v_session.context_window_start_turn,
    p_max_context_turns,
    p_retain_context_turns
  );

  INSERT INTO miniapp.chat_history (
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

CREATE OR REPLACE FUNCTION miniapp.start_chat_history_regeneration(
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
  v_session miniapp.chat_sessions%ROWTYPE;
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
  FROM miniapp.chat_sessions
  WHERE id = p_session_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM miniapp.guard_chat_session_idle(p_session_id, p_stale_after_seconds);

  SELECT max(turn_index) INTO v_last_turn
  FROM miniapp.chat_history
  WHERE session_id = p_session_id AND turn_index IS NOT NULL;

  IF v_last_turn IS NULL OR (p_turn_index IS NOT NULL AND p_turn_index <> v_last_turn) THEN
    RAISE EXCEPTION 'only the last turn can be regenerated' USING ERRCODE = '55000';
  END IF;

  SELECT user_input INTO v_user_content
  FROM miniapp.chat_history
  WHERE session_id = p_session_id AND turn_index = v_last_turn
  ORDER BY revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn % has no user input to regenerate from', v_last_turn
      USING ERRCODE = '55000';
  END IF;

  v_window_start := miniapp.apply_context_window_flood(
    p_session_id,
    v_last_turn - 1,
    v_session.context_window_start_turn,
    p_max_context_turns,
    p_retain_context_turns
  );

  SELECT COALESCE(max(revision), -1) + 1 INTO v_revision
  FROM miniapp.chat_history
  WHERE session_id = p_session_id AND turn_index = v_last_turn;

  INSERT INTO miniapp.chat_history (
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

REVOKE ALL ON FUNCTION miniapp.apply_context_window_flood(UUID, INTEGER, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.start_chat_history_turn(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.start_chat_history_regeneration(UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp.start_chat_history_turn(UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.start_chat_history_regeneration(UUID, INTEGER, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role, postgres;

COMMIT;

NOTIFY pgrst, 'reload schema';
