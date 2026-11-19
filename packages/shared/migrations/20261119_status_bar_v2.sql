-- Domain: experience（对话派生的状态记录）+ app_core（玩家对角色卡的状态栏覆盖版）
-- 设计：.trellis/tasks/11-19-custom-status-bar/design.md §6、implement.md §3；落位规则见 docs/db/CONTRACT.md §2。
--
--   1. app_core.user_character_preferences.status_bar_detail（S，同表同性质同写入模块）：
--      玩家在工具箱里改过的这张卡的状态栏；NULL = 用卡自带的。
--   2. experience.chat_status_snapshots（D，由对话派生，同 story_memories）：
--      每次状态更新的结果，锚在"更新时当前路径上的最新一轮（那一版）"上。
--      重新生成正文后旧版本不在当前路径上，记录自然失效；分支会话经 session_chat_history
--      的继承行看到父会话在分叉点之前的记录。
--   3. 函数：get_chat_status（读当前路径上最近一条有效记录）、
--            record_chat_status（同一锚点只留一条，替换时记 replaces_id，供撤销恢复）、
--            undo_chat_status（撤销本会话最近一条，恢复被它替换的那条）。
--   作者的状态栏写在 app_core.character_versions.runtime 的 status_bar 键里（无 DDL）。
--
-- 纯新增对象，没有旧数据、没有回填。
-- 执行顺序：TEST → 生产；先迁移，再部署后端与前端。
-- 回滚：回退后端/前端即可，对象保留。如需删除（会丢失状态记录和玩家改过的状态栏，需用户同意）：
--   DROP FUNCTION experience.undo_chat_status(uuid, uuid);
--   DROP FUNCTION experience.record_chat_status(uuid, uuid, uuid, integer, text, text, text);
--   DROP FUNCTION experience.get_chat_status(uuid);
--   DROP TABLE experience.chat_status_snapshots;
--   ALTER TABLE app_core.user_character_preferences DROP COLUMN status_bar_detail;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.user_character_preferences') IS NULL
     OR to_regclass('experience.chat_sessions') IS NULL
     OR to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.session_chat_history') IS NULL THEN
    RAISE EXCEPTION 'status bar v2: prerequisite objects missing';
  END IF;
  IF to_regclass('experience.chat_status_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'status bar v2: target table already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_core' AND table_name = 'user_character_preferences'
      AND column_name = 'status_bar_detail'
  ) THEN
    RAISE EXCEPTION 'status bar v2: status_bar_detail already exists';
  END IF;
END
$preflight$;

-- ── 1. 玩家覆盖版 ───────────────────────────────────────────────────────────
ALTER TABLE app_core.user_character_preferences
  ADD COLUMN status_bar_detail jsonb NULL,
  ADD CONSTRAINT user_character_preferences_status_bar_detail_check CHECK (
    status_bar_detail IS NULL
    OR (jsonb_typeof(status_bar_detail) = 'object' AND octet_length(status_bar_detail::text) <= 16384)
  );
COMMENT ON COLUMN app_core.user_character_preferences.status_bar_detail IS
  '玩家在工具箱里改过的这张卡的状态栏（shared StatusBarTemplate，后端写入前做语义校验）；NULL = 用卡自带的。';

-- ── 2. 状态记录 ─────────────────────────────────────────────────────────────
CREATE TABLE experience.chat_status_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  anchor_history_id uuid NOT NULL,
  anchor_turn_index integer NOT NULL,
  status_text text NOT NULL,
  template_source text NOT NULL,
  trigger text NOT NULL,
  replaces_id uuid NULL,
  discarded_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_status_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT chat_status_snapshots_session_fkey FOREIGN KEY (session_id)
    REFERENCES experience.chat_sessions (id) ON DELETE CASCADE,
  CONSTRAINT chat_status_snapshots_user_fkey FOREIGN KEY (user_id)
    REFERENCES app_core.users (id) ON DELETE CASCADE,
  CONSTRAINT chat_status_snapshots_anchor_fkey FOREIGN KEY (anchor_history_id)
    REFERENCES experience.chat_history (id) ON DELETE CASCADE,
  CONSTRAINT chat_status_snapshots_replaces_fkey FOREIGN KEY (replaces_id)
    REFERENCES experience.chat_status_snapshots (id) ON DELETE SET NULL,
  CONSTRAINT chat_status_snapshots_turn_check CHECK (anchor_turn_index BETWEEN 1 AND 100000),
  CONSTRAINT chat_status_snapshots_text_check CHECK (char_length(status_text) BETWEEN 1 AND 8000),
  CONSTRAINT chat_status_snapshots_source_check CHECK (template_source IN ('card', 'player', 'auto')),
  CONSTRAINT chat_status_snapshots_trigger_check CHECK (trigger IN ('auto', 'manual'))
);
-- 同一会话、同一锚点只保留一条有效记录（"重新生成"会替换它）。
CREATE UNIQUE INDEX chat_status_snapshots_active_anchor_idx
  ON experience.chat_status_snapshots (session_id, anchor_history_id) WHERE discarded_at IS NULL;
CREATE INDEX chat_status_snapshots_session_idx
  ON experience.chat_status_snapshots (session_id, anchor_turn_index DESC, created_at DESC)
  WHERE discarded_at IS NULL;
CREATE INDEX chat_status_snapshots_anchor_idx
  ON experience.chat_status_snapshots (anchor_history_id);

ALTER TABLE experience.chat_status_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_status_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.chat_status_snapshots TO service_role;

COMMENT ON TABLE experience.chat_status_snapshots IS
  '状态面板的每次更新结果（每 5 轮自动 / 玩家手动）。由对话派生，只经 record_chat_status / undo_chat_status 写入；随会话、锚定轮次级联删除。';
COMMENT ON COLUMN experience.chat_status_snapshots.anchor_history_id IS
  '更新时当前路径上最新一轮的那一版（chat_history.id）；不在当前路径上的记录不再生效。';
COMMENT ON COLUMN experience.chat_status_snapshots.status_text IS
  '规范状态文本（v2 行语法，shared validateStatusOutput 产出），下次更新作为"上次记录的状态"喂回模型。';
COMMENT ON COLUMN experience.chat_status_snapshots.replaces_id IS
  '同一锚点被重新生成替换掉的那条；撤销时恢复它。';

-- ── 3. 读：当前路径上最近一条有效记录 ───────────────────────────────────────
-- 有效 = 未撤销、锚点在本会话当前路径上（含分支继承行），且记录属于本会话或其祖先会话。
CREATE FUNCTION experience.get_chat_status(p_session_id uuid)
RETURNS TABLE (
  snapshot_id uuid,
  status_text text,
  anchor_turn_index integer,
  trigger text,
  template_source text,
  created_at timestamptz,
  can_undo boolean
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
  SELECT snap.id, snap.status_text, snap.anchor_turn_index, snap.trigger, snap.template_source,
         snap.created_at, snap.session_id = p_session_id AS can_undo
  FROM experience.chat_status_snapshots AS snap
  JOIN path ON path.id = snap.anchor_history_id
  WHERE snap.discarded_at IS NULL
    AND snap.session_id IN (SELECT lineage.id FROM lineage)
  ORDER BY snap.anchor_turn_index DESC, snap.created_at DESC
  LIMIT 1;
$$;

-- ── 4. 写：记录一次更新 ─────────────────────────────────────────────────────
-- 同一锚点已有有效记录时先作废它，并把它记进 replaces_id，撤销时可以恢复。
CREATE FUNCTION experience.record_chat_status(
  p_session_id uuid,
  p_user_id uuid,
  p_anchor_history_id uuid,
  p_anchor_turn_index integer,
  p_status_text text,
  p_template_source text,
  p_trigger text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_replaced uuid;
  v_id uuid;
BEGIN
  -- 手动和自动可能同时落库：按会话串行化，后到的替换先到的。
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_status:' || p_session_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM experience.chat_sessions AS s WHERE s.id = p_session_id AND s.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'chat session not found' USING ERRCODE = 'P0002', DETAIL = 'session_not_found';
  END IF;
  UPDATE experience.chat_status_snapshots
  SET discarded_at = now()
  WHERE session_id = p_session_id AND anchor_history_id = p_anchor_history_id AND discarded_at IS NULL
  RETURNING id INTO v_replaced;
  INSERT INTO experience.chat_status_snapshots (
    session_id, user_id, anchor_history_id, anchor_turn_index, status_text, template_source, trigger, replaces_id
  ) VALUES (
    p_session_id, p_user_id, p_anchor_history_id, p_anchor_turn_index, p_status_text, p_template_source, p_trigger, v_replaced
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ── 5. 撤销：作废本会话当前生效的那条，恢复它替换掉的那条 ─────────────────────
CREATE FUNCTION experience.undo_chat_status(p_session_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_status:' || p_session_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM experience.chat_sessions AS s WHERE s.id = p_session_id AND s.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'chat session not found' USING ERRCODE = 'P0002', DETAIL = 'session_not_found';
  END IF;
  SELECT g.snapshot_id, g.can_undo INTO v_current FROM experience.get_chat_status(p_session_id) AS g;
  IF v_current.snapshot_id IS NULL OR NOT v_current.can_undo THEN
    RETURN false;
  END IF;
  UPDATE experience.chat_status_snapshots SET discarded_at = now()
  WHERE id = v_current.snapshot_id AND discarded_at IS NULL;
  UPDATE experience.chat_status_snapshots AS restored SET discarded_at = NULL
  FROM experience.chat_status_snapshots AS cur
  WHERE cur.id = v_current.snapshot_id AND restored.id = cur.replaces_id
    AND restored.discarded_at IS NOT NULL;
  RETURN true;
END
$$;

ALTER FUNCTION experience.get_chat_status(uuid) OWNER TO postgres;
ALTER FUNCTION experience.record_chat_status(uuid, uuid, uuid, integer, text, text, text) OWNER TO postgres;
ALTER FUNCTION experience.undo_chat_status(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.get_chat_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.record_chat_status(uuid, uuid, uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.undo_chat_status(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.get_chat_status(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION experience.record_chat_status(uuid, uuid, uuid, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION experience.undo_chat_status(uuid, uuid) TO service_role;

COMMIT;
