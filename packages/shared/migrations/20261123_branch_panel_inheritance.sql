-- Domain: experience（状态栏、记忆栏的读取函数）
-- 设计：.trellis/tasks/11-23-memory-panel/task.md（T13）。
--
-- 用户 11-23 定：开分支就继承分叉那一刻的状态栏和记忆栏。原来的读法有两个问题：
--   1. 分支只带长期记忆压缩点之后的轮次、从 1 重新编号（fork_chat_session），父会话的记录却按父会话的编号
--      排序和返回：父会话第 40 轮在分支里是第 4 轮。后端拿"最新一轮 − 上次记录的轮次"判断要不要更新，
--      差值成了负数，分支里状态栏、记忆栏要多走几十上百轮才再更新；分支自己写的新记录也排不过父会话那条。
--   2. 父会话的记录锚在被压缩的那段轮次上时，不在分支路径里，分支什么都继承不到。
--
-- 新读法（get_chat_status、get_chat_memory 同一套，返回列不变）：
--   - 本会话的记录：锚在本会话当前路径上（含继承来的轮次）；
--   - 祖先会话的记录：锚在分叉点（含）之前；换算成本会话编号后落在已有轮次里的，必须正是本会话继承的那一版，
--     落在分支开头之前的（≤ 0）也算继承；
--   - 按本会话编号取最新一条，同一轮本会话优先；返回的 anchor_turn_index 是本会话编号（可能 ≤ 0）。
--   记忆快照里的轮次号由后端按返回的编号整体平移（shared rebaseMemoryBarState）。
-- 换算：turn_shift = 祖先编号 − 本会话编号，逐层累加（分叉点编号 − 继承轮数）；turn_limit = 分叉点在祖先里的编号。
--
-- 生产只读试跑（11-23）：166 个分支选中的记录与原来完全一致，只有返回的轮次号换算成分支编号（6 个分支随即恢复
-- 自动更新）；最大分支单次读取 6.7ms（原 9.7ms）。
-- 执行：TEST → 生产（需确认）。只替换两个函数，无锁表、无数据变更；先于或晚于后端发布都可以。
-- 回滚：按 git 历史恢复两个函数的原定义（20261119_status_bar_v2 / 20261123_memory_panel）。
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 替换前记下每个分支现在读到的记录，替换后核对：原来读得到的，现在必须还读得到（新候选集是原来的超集）
CREATE TEMP TABLE _panel_before ON COMMIT DROP AS
SELECT s.id AS session_id,
  (SELECT g.snapshot_id FROM experience.get_chat_status(s.id) AS g) AS status_id,
  (SELECT g.snapshot_id FROM experience.get_chat_memory(s.id) AS g) AS memory_id
FROM experience.chat_sessions AS s
WHERE s.branch_source_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION experience.get_chat_status(p_session_id uuid)
RETURNS TABLE(snapshot_id uuid, status_text text, anchor_turn_index integer, trigger text, template_source text, created_at timestamptz, can_undo boolean)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog'
AS $function$
  WITH RECURSIVE lineage(session_id, depth, turn_limit, turn_shift) AS (
    SELECT p_session_id, 0, NULL::integer, 0
    UNION ALL
    SELECT s.branch_source_session_id, l.depth + 1,
           LEAST(s.branch_source_turn_index, l.turn_limit + fork.shift),
           l.turn_shift + fork.shift
    FROM lineage AS l
    JOIN experience.chat_sessions AS s ON s.id = l.session_id
    CROSS JOIN LATERAL (
      SELECT s.branch_source_turn_index - count(*)::integer AS shift
      FROM experience.chat_branch_turns AS bt WHERE bt.session_id = s.id
    ) AS fork
    WHERE s.branch_source_session_id IS NOT NULL AND l.depth < 20
  ),
  own_path AS (
    SELECT h.id, h.turn_index FROM experience.session_chat_history AS h WHERE h.session_id = p_session_id
  ),
  candidates AS (
    SELECT snap.id, snap.status_text, snap.trigger, snap.template_source, snap.created_at,
           own_path.turn_index AS local_turn, 0 AS depth
    FROM experience.chat_status_snapshots AS snap
    JOIN own_path ON own_path.id = snap.anchor_history_id
    WHERE snap.session_id = p_session_id AND snap.discarded_at IS NULL
    UNION ALL
    SELECT snap.id, snap.status_text, snap.trigger, snap.template_source, snap.created_at,
           snap.anchor_turn_index - l.turn_shift, l.depth
    FROM lineage AS l
    JOIN experience.chat_status_snapshots AS snap ON snap.session_id = l.session_id
    WHERE l.depth > 0 AND snap.discarded_at IS NULL
      AND snap.anchor_turn_index <= l.turn_limit
      AND (snap.anchor_turn_index - l.turn_shift < 1
           OR snap.anchor_history_id IN (SELECT own_path.id FROM own_path))
  )
  SELECT c.id, c.status_text, c.local_turn, c.trigger, c.template_source, c.created_at, c.depth = 0
  FROM candidates AS c
  ORDER BY c.local_turn DESC, c.depth, c.created_at DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION experience.get_chat_memory(p_session_id uuid)
RETURNS TABLE(snapshot_id uuid, memory_snapshot jsonb, anchor_turn_index integer, trigger text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  WITH RECURSIVE lineage(session_id, depth, turn_limit, turn_shift) AS (
    SELECT p_session_id, 0, NULL::integer, 0
    UNION ALL
    SELECT s.branch_source_session_id, l.depth + 1,
           LEAST(s.branch_source_turn_index, l.turn_limit + fork.shift),
           l.turn_shift + fork.shift
    FROM lineage AS l
    JOIN experience.chat_sessions AS s ON s.id = l.session_id
    CROSS JOIN LATERAL (
      SELECT s.branch_source_turn_index - count(*)::integer AS shift
      FROM experience.chat_branch_turns AS bt WHERE bt.session_id = s.id
    ) AS fork
    WHERE s.branch_source_session_id IS NOT NULL AND l.depth < 20
  ),
  own_path AS (
    SELECT h.id, h.turn_index FROM experience.session_chat_history AS h WHERE h.session_id = p_session_id
  ),
  candidates AS (
    SELECT snap.id, snap.memory_snapshot, snap.trigger, snap.created_at,
           own_path.turn_index AS local_turn, 0 AS depth
    FROM experience.chat_memory_snapshots AS snap
    JOIN own_path ON own_path.id = snap.anchor_history_id
    WHERE snap.session_id = p_session_id
    UNION ALL
    SELECT snap.id, snap.memory_snapshot, snap.trigger, snap.created_at,
           snap.anchor_turn_index - l.turn_shift, l.depth
    FROM lineage AS l
    JOIN experience.chat_memory_snapshots AS snap ON snap.session_id = l.session_id
    WHERE l.depth > 0
      AND snap.anchor_turn_index <= l.turn_limit
      AND (snap.anchor_turn_index - l.turn_shift < 1
           OR snap.anchor_history_id IN (SELECT own_path.id FROM own_path))
  )
  SELECT c.id, c.memory_snapshot, c.local_turn, c.trigger, c.created_at
  FROM candidates AS c
  ORDER BY c.local_turn DESC, c.depth, c.created_at DESC
  LIMIT 1;
$function$;

DO $verify$
DECLARE
  v_lost_status integer;
  v_lost_memory integer;
  v_changed integer;
BEGIN
  SELECT count(*) FILTER (WHERE b.status_id IS NOT NULL AND n.status_id IS NULL),
         count(*) FILTER (WHERE b.memory_id IS NOT NULL AND n.memory_id IS NULL),
         count(*) FILTER (WHERE b.status_id IS DISTINCT FROM n.status_id OR b.memory_id IS DISTINCT FROM n.memory_id)
    INTO v_lost_status, v_lost_memory, v_changed
  FROM _panel_before AS b
  CROSS JOIN LATERAL (
    SELECT (SELECT g.snapshot_id FROM experience.get_chat_status(b.session_id) AS g) AS status_id,
           (SELECT g.snapshot_id FROM experience.get_chat_memory(b.session_id) AS g) AS memory_id
  ) AS n;
  IF v_lost_status > 0 OR v_lost_memory > 0 THEN
    RAISE EXCEPTION 'branch panel inheritance: % branches lost status, % lost memory', v_lost_status, v_lost_memory;
  END IF;
  RAISE NOTICE 'branch panel inheritance: % branches now read a different record (inheritance fixed)', v_changed;
END
$verify$;

COMMIT;
