-- Domain: experience（对话派生的记忆栏记录）+ app_core（玩家对角色卡记忆栏的要求）
-- 设计：.trellis/tasks/11-23-memory-panel/design.md §6；落位规则见 docs/db/CONTRACT.md §2。
--
--   1. app_core.user_character_preferences.memory_request（S，同表同性质，写法同 status_bar_detail）：
--      玩家对这张卡记忆栏的要求（≤300 字）；NULL = 没写。
--   2. experience.chat_memory_snapshots（D，由对话派生，同 chat_status_snapshots）：
--      记忆栏每次有变化的检查结果（整份记忆快照），锚在"检查时当前路径上的最新一轮（那一版）"上。
--      重新生成正文后旧版本不在当前路径上，记录自然失效；分支会话经 session_chat_history
--      的继承行看到父会话在分叉点之前的记录。没有进展的检查不落库。不做撤销。
--   3. 函数：get_chat_memory（读当前路径上最近一条）、
--            record_chat_memory（写入前比对"读到的那条"仍是当前最新，否则放弃返回 NULL；同一锚点只留一条）。
--
-- 纯新增对象，不改旧数据。
-- 执行顺序：TEST → 生产；先迁移，再部署后端与前端。
-- 回滚：回退后端/前端即可，对象保留。如需删除（会丢失记忆记录和玩家写的要求，需用户同意）：
--   DROP FUNCTION experience.record_chat_memory(uuid, uuid, uuid, integer, jsonb, integer, text, integer, uuid);
--   DROP FUNCTION experience.get_chat_memory(uuid);
--   DROP TABLE experience.chat_memory_snapshots;
--   ALTER TABLE app_core.user_character_preferences DROP COLUMN memory_request;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.user_character_preferences') IS NULL
     OR to_regclass('app_core.users') IS NULL
     OR to_regclass('experience.chat_sessions') IS NULL
     OR to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.session_chat_history') IS NULL
     OR to_regprocedure('experience.get_chat_status(uuid)') IS NULL THEN
    RAISE EXCEPTION 'memory panel: prerequisite objects missing';
  END IF;
  IF to_regclass('experience.chat_memory_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'memory panel: target table already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_core' AND table_name = 'user_character_preferences'
      AND column_name = 'memory_request'
  ) THEN
    RAISE EXCEPTION 'memory panel: memory_request already exists';
  END IF;
END
$preflight$;

-- ── 1. 玩家的记忆要求 ───────────────────────────────────────────────────────
ALTER TABLE app_core.user_character_preferences
  ADD COLUMN memory_request text NULL,
  ADD CONSTRAINT user_character_preferences_memory_request_check CHECK (
    memory_request IS NULL OR char_length(memory_request) BETWEEN 1 AND 300
  );
COMMENT ON COLUMN app_core.user_character_preferences.memory_request IS
  '玩家对这张卡记忆栏的要求（内容上优先照办，结构和字数不变）；NULL = 没写。只经后端 MemoryBarRepository 写这一列。';

-- ── 2. 记忆记录 ─────────────────────────────────────────────────────────────
CREATE TABLE experience.chat_memory_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  anchor_history_id uuid NOT NULL,
  anchor_turn_index integer NOT NULL,
  memory_snapshot jsonb NOT NULL,
  memory_chars integer NOT NULL,
  trigger text NOT NULL,
  prompt_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_memory_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT chat_memory_snapshots_session_fkey FOREIGN KEY (session_id)
    REFERENCES experience.chat_sessions (id) ON DELETE CASCADE,
  CONSTRAINT chat_memory_snapshots_user_fkey FOREIGN KEY (user_id)
    REFERENCES app_core.users (id) ON DELETE CASCADE,
  CONSTRAINT chat_memory_snapshots_anchor_fkey FOREIGN KEY (anchor_history_id)
    REFERENCES experience.chat_history (id) ON DELETE CASCADE,
  CONSTRAINT chat_memory_snapshots_turn_check CHECK (anchor_turn_index BETWEEN 1 AND 100000),
  CONSTRAINT chat_memory_snapshots_snapshot_check CHECK (
    jsonb_typeof(memory_snapshot) = 'object' AND octet_length(memory_snapshot::text) <= 32768
  ),
  CONSTRAINT chat_memory_snapshots_chars_check CHECK (memory_chars BETWEEN 0 AND 4000),
  CONSTRAINT chat_memory_snapshots_trigger_check CHECK (trigger IN ('auto', 'manual')),
  CONSTRAINT chat_memory_snapshots_prompt_version_check CHECK (prompt_version BETWEEN 1 AND 1000)
);
-- 同一会话、同一锚点只保留一条（后写的覆盖）。
CREATE UNIQUE INDEX chat_memory_snapshots_anchor_uidx
  ON experience.chat_memory_snapshots (session_id, anchor_history_id);
CREATE INDEX chat_memory_snapshots_session_idx
  ON experience.chat_memory_snapshots (session_id, anchor_turn_index DESC, created_at DESC);
CREATE INDEX chat_memory_snapshots_anchor_idx
  ON experience.chat_memory_snapshots (anchor_history_id);

ALTER TABLE experience.chat_memory_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_memory_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.chat_memory_snapshots TO service_role;

COMMENT ON TABLE experience.chat_memory_snapshots IS
  '记忆栏每次有变化的检查结果（每 3 轮检查 / 玩家手动；没进展不落库）。由对话派生，只经 record_chat_memory 写入；随会话、锚定轮次级联删除。';
COMMENT ON COLUMN experience.chat_memory_snapshots.anchor_history_id IS
  '检查时当前路径上最新一轮的那一版（chat_history.id）；不在当前路径上的记录不再生效。';
COMMENT ON COLUMN experience.chat_memory_snapshots.memory_snapshot IS
  '整份记忆快照（shared MemoryBarStateSchema：version / covered_turn / summary / milestones / records），写一次不改；下次检查在它上面追加。';
COMMENT ON COLUMN experience.chat_memory_snapshots.memory_chars IS
  '整份记忆的字数（shared memoryBarChars），≤ 4000。';

-- ── 3. 读：当前路径上最近一条 ───────────────────────────────────────────────
-- 有效 = 锚点在本会话当前路径上（含分支继承行），且记录属于本会话或其祖先会话。
CREATE FUNCTION experience.get_chat_memory(p_session_id uuid)
RETURNS TABLE (
  snapshot_id uuid,
  memory_snapshot jsonb,
  anchor_turn_index integer,
  trigger text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  WITH RECURSIVE lineage(id, depth) AS (
    SELECT s.id, 0 FROM experience.chat_sessions AS s WHERE s.id = p_session_id
    UNION ALL
    SELECT parent.branch_source_session_id, l.depth + 1
    FROM lineage AS l
    JOIN experience.chat_sessions AS parent ON parent.id = l.id
    WHERE parent.branch_source_session_id IS NOT NULL AND l.depth < 20
  ),
  path AS (
    SELECT h.id FROM experience.session_chat_history AS h WHERE h.session_id = p_session_id
  )
  SELECT snap.id, snap.memory_snapshot, snap.anchor_turn_index, snap.trigger, snap.created_at
  FROM experience.chat_memory_snapshots AS snap
  JOIN path ON path.id = snap.anchor_history_id
  WHERE snap.session_id IN (SELECT lineage.id FROM lineage)
  ORDER BY snap.anchor_turn_index DESC, snap.created_at DESC
  LIMIT 1;
$$;

-- ── 4. 写：记录一次有变化的检查 ─────────────────────────────────────────────
-- p_expected_previous_id = 这次检查读到的那条（没有为 NULL）。写入前按会话加锁，
-- 当前最新已不是它（别的检查先写了），就放弃并返回 NULL，调用方下次再看。
CREATE FUNCTION experience.record_chat_memory(
  p_session_id uuid,
  p_user_id uuid,
  p_anchor_history_id uuid,
  p_anchor_turn_index integer,
  p_memory_snapshot jsonb,
  p_memory_chars integer,
  p_trigger text,
  p_prompt_version integer,
  p_expected_previous_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current uuid;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_memory:' || p_session_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM experience.chat_sessions AS s WHERE s.id = p_session_id AND s.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'chat session not found' USING ERRCODE = 'P0002', DETAIL = 'session_not_found';
  END IF;
  SELECT g.snapshot_id INTO v_current FROM experience.get_chat_memory(p_session_id) AS g;
  IF v_current IS DISTINCT FROM p_expected_previous_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO experience.chat_memory_snapshots AS snap (
    session_id, user_id, anchor_history_id, anchor_turn_index, memory_snapshot, memory_chars, trigger, prompt_version
  ) VALUES (
    p_session_id, p_user_id, p_anchor_history_id, p_anchor_turn_index, p_memory_snapshot, p_memory_chars, p_trigger, p_prompt_version
  )
  ON CONFLICT (session_id, anchor_history_id) DO UPDATE SET
    anchor_turn_index = EXCLUDED.anchor_turn_index,
    memory_snapshot = EXCLUDED.memory_snapshot,
    memory_chars = EXCLUDED.memory_chars,
    trigger = EXCLUDED.trigger,
    prompt_version = EXCLUDED.prompt_version,
    created_at = now()
  RETURNING snap.id INTO v_id;
  RETURN v_id;
END
$$;

ALTER FUNCTION experience.get_chat_memory(uuid) OWNER TO postgres;
ALTER FUNCTION experience.record_chat_memory(uuid, uuid, uuid, integer, jsonb, integer, text, integer, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.get_chat_memory(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.record_chat_memory(uuid, uuid, uuid, integer, jsonb, integer, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.get_chat_memory(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION experience.record_chat_memory(uuid, uuid, uuid, integer, jsonb, integer, text, integer, uuid) TO service_role;

COMMIT;
