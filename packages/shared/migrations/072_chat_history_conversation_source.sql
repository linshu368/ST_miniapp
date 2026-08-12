-- M3b 对话存储收口：chat_sessions + chat_history 成为唯一事实来源。
--
-- chat_history 一行表示「一个 session 内一轮用户输入的一个生成版本」：
--   turn_index：session 内用户主动发起的逻辑轮次，从 1 递增；重生成不变
--   revision：  同一 turn 的生成版本，首次为 0，每次重生成 +1
--
-- ST 链路的存量/新增日志没有 session_id，两个字段保持 NULL，不受本迁移影响。
-- 开场白不单独落行；首轮实际发给模型的 history JSONB 负责保存它。

BEGIN;

ALTER TABLE miniapp.chat_history
  ADD COLUMN IF NOT EXISTS turn_index INTEGER,
  ADD COLUMN IF NOT EXISTS revision INTEGER;

ALTER TABLE miniapp.chat_history
  DROP CONSTRAINT IF EXISTS chat_history_turn_index_check,
  DROP CONSTRAINT IF EXISTS chat_history_revision_check;

ALTER TABLE miniapp.chat_history
  ADD CONSTRAINT chat_history_turn_index_check
    CHECK (turn_index IS NULL OR turn_index > 0),
  ADD CONSTRAINT chat_history_revision_check
    CHECK (revision IS NULL OR revision >= 0);

COMMENT ON COLUMN miniapp.chat_history.turn_index IS
  '自研会话内由用户主动发起的逻辑轮次，从 1 递增；ST 日志为 NULL。';
COMMENT ON COLUMN miniapp.chat_history.revision IS
  '同一 session + turn 的生成版本，首次为 0，重生成递增；最大 revision 为当前版本。ST 日志为 NULL。';

-- 先把 M3b 试运行期间已同时写进两张表的记录按 generation/charge id 对齐。
UPDATE miniapp.chat_history AS h
SET turn_index = m.turn_index,
    revision = m.revision
FROM miniapp.chat_messages AS m
WHERE h.session_id = m.session_id
  AND m.role = 'assistant'
  AND h.turn_index IS NULL
  AND (
    (h.llm_generation_id IS NOT NULL AND h.llm_generation_id = m.generation_id)
    OR (h.llm_charge_id IS NOT NULL AND h.llm_charge_id = m.charge_id)
  );

-- 极少数旧自研日志没有可关联的 generation/charge id，按 session 内调用时间顺序补成独立轮次。
WITH base AS (
  SELECT session_id, COALESCE(max(turn_index), 0) AS max_turn
  FROM miniapp.chat_history
  WHERE session_id IS NOT NULL
  GROUP BY session_id
),
ranked AS (
  SELECT
    h.id,
    COALESCE(base.max_turn, 0)
      + row_number() OVER (PARTITION BY h.session_id ORDER BY h.created_at, h.id) AS turn_index
  FROM miniapp.chat_history AS h
  LEFT JOIN base ON base.session_id = h.session_id
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NULL
)
UPDATE miniapp.chat_history AS h
SET turn_index = ranked.turn_index,
    revision = 0
FROM ranked
WHERE h.id = ranked.id;

UPDATE miniapp.chat_history
SET revision = 0
WHERE session_id IS NOT NULL AND turn_index IS NOT NULL AND revision IS NULL;

-- chat_messages 中尚未形成调用日志的状态（例如 402、上游连接失败）也要保留。
-- 这些行没有完整 prompt 快照，只能以 [] 迁移；新代码从本迁移起会在调用前写入真实 history。
ALTER TABLE miniapp.chat_history DISABLE TRIGGER trg_set_user_character_round;

INSERT INTO miniapp.chat_history (
  id,
  user_id,
  model,
  user_input,
  assistant_reply,
  history,
  character_id,
  preset_id,
  status,
  created_at,
  llm_finish_reason,
  llm_generation_id,
  llm_charge_id,
  session_id,
  turn_index,
  revision
)
SELECT
  m.id,
  s.user_id,
  COALESCE(m.model_openrouter_id, m.model_id, 'unknown'),
  u.content,
  CASE WHEN m.status = 'streaming' THEN NULL ELSE m.content END,
  '[]'::jsonb,
  s.character_id,
  m.preset_id,
  CASE m.status
    WHEN 'complete' THEN 'success'
    WHEN 'interrupted' THEN 'stream_interrupted'
    WHEN 'failed' THEN COALESCE(m.error_code, 'upstream_error')
    ELSE 'streaming'
  END,
  m.created_at,
  m.finish_reason,
  m.generation_id,
  m.charge_id,
  m.session_id,
  m.turn_index,
  m.revision
FROM miniapp.chat_messages AS m
JOIN miniapp.chat_sessions AS s ON s.id = m.session_id
JOIN miniapp.chat_messages AS u
  ON u.session_id = m.session_id
 AND u.turn_index = m.turn_index
 AND u.role = 'user'
WHERE m.role = 'assistant'
  AND m.turn_index > 0
  AND NOT EXISTS (
    SELECT 1
    FROM miniapp.chat_history AS h
    WHERE h.session_id = m.session_id
      AND h.turn_index = m.turn_index
      AND h.revision = m.revision
  );

ALTER TABLE miniapp.chat_history ENABLE TRIGGER trg_set_user_character_round;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_history_session_turn_revision
  ON miniapp.chat_history(session_id, turn_index, revision)
  WHERE session_id IS NOT NULL AND turn_index IS NOT NULL AND revision IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_history_session_current
  ON miniapp.chat_history(session_id, turn_index, revision DESC)
  WHERE session_id IS NOT NULL AND turn_index IS NOT NULL;

-- ─── 会话原子操作 ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION miniapp.guard_chat_session_idle(
  p_session_id UUID,
  p_stale_after_seconds INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE miniapp.chat_history
  SET status = 'stream_interrupted'
  WHERE session_id = p_session_id
    AND status = 'streaming'
    AND created_at < now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1));

  IF EXISTS (
    SELECT 1
    FROM miniapp.chat_history
    WHERE session_id = p_session_id AND status = 'streaming'
  ) THEN
    RAISE EXCEPTION 'chat session % already has a streaming reply', p_session_id
      USING ERRCODE = '55006';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.start_chat_history_turn(
  p_session_id UUID,
  p_user_content TEXT,
  p_model TEXT,
  p_stale_after_seconds INTEGER DEFAULT 120
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session miniapp.chat_sessions%ROWTYPE;
  v_turn_index INTEGER;
  v_history_id UUID;
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
    'revision', 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.start_chat_history_regeneration(
  p_session_id UUID,
  p_turn_index INTEGER DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
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
  v_history_id UUID;
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
    'user_content', v_user_content
  );
END;
$$;

REVOKE ALL ON FUNCTION miniapp.start_chat_history_turn(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.start_chat_history_regeneration(UUID, INTEGER, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp.start_chat_history_turn(UUID, TEXT, TEXT, INTEGER)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.start_chat_history_regeneration(UUID, INTEGER, TEXT, INTEGER)
  TO service_role, postgres;

-- ─── 会话列表冗余字段 ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION miniapp.tf_refresh_chat_session_stats_from_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session_id UUID := NEW.session_id;
BEGIN
  IF v_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE miniapp.chat_sessions AS s
  SET message_count = stats.turn_count * 2,
      last_message_at = stats.last_at,
      last_message_preview = stats.preview,
      updated_at = now()
  FROM (
    WITH current_turns AS (
      SELECT DISTINCT ON (turn_index)
        turn_index, user_input, assistant_reply, created_at
      FROM miniapp.chat_history
      WHERE session_id = v_session_id AND turn_index IS NOT NULL
      ORDER BY turn_index, revision DESC
    )
    SELECT
      count(*)::INTEGER AS turn_count,
      max(created_at) AS last_at,
      (
        SELECT left(
          btrim(regexp_replace(COALESCE(NULLIF(assistant_reply, ''), user_input), '\s+', ' ', 'g')),
          120
        )
        FROM current_turns
        ORDER BY turn_index DESC
        LIMIT 1
      ) AS preview
    FROM current_turns
  ) AS stats
  WHERE s.id = v_session_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_chat_session_stats_from_history ON miniapp.chat_history;
CREATE TRIGGER trg_refresh_chat_session_stats_from_history
AFTER INSERT OR UPDATE OF assistant_reply, status ON miniapp.chat_history
FOR EACH ROW
WHEN (NEW.session_id IS NOT NULL)
EXECUTE FUNCTION miniapp.tf_refresh_chat_session_stats_from_history();

-- 旧 M1 表及其专用 RPC 到这里才移除，确保上面的回填已经完成。
DROP FUNCTION IF EXISTS miniapp.append_chat_turn(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS miniapp.start_message_regeneration(UUID, INTEGER, TEXT, TEXT, UUID, JSONB, INTEGER);
DROP TRIGGER IF EXISTS trg_refresh_chat_session_stats ON miniapp.chat_messages;
DROP FUNCTION IF EXISTS miniapp.tf_refresh_chat_session_stats();
DROP TABLE miniapp.chat_messages;

COMMIT;

NOTIFY pgrst, 'reload schema';
