-- domain: experience. 用户为自己的对话建立的分组（文件夹）；一段对话最多属于一个分组。
-- 归属：分组组织的是用户核心互动内容（文本会话），与 chat_sessions 同生命周期、同消费者（对话页），
-- 是会话自身的属性而非可独立下线的功能状态，所以进 experience 而不是 miniapp_features。
-- Prerequisite: experience.chat_sessions 含 pinned_at（078 之后的形状）；PostgreSQL 15+（列级 ON DELETE SET NULL）。
-- Verify: 本地 PG17 连续执行两次应无报错；TEST 经 db-migrate workflow 执行后核对 shape、ACL 与两个函数返回。
-- Release: TEST -> production migration -> Backend -> Frontend。旧 Backend 不读新列，迁移先行安全。
-- Recovery: 回退应用即可，保留表、列与函数（用户整理过的分组不 DROP）；数据库缺陷走 forward-fix。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('experience.chat_sessions') IS NULL THEN
    RAISE EXCEPTION 'experience.chat_sessions missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'experience.chat_sessions'::regclass AND attname = 'pinned_at' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'chat_sessions.pinned_at missing; run 078_chat_session_pinned.sql first';
  END IF;
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'PostgreSQL 15+ required for ON DELETE SET NULL (folder_id)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'experience.chat_sessions'::regclass AND attname = 'folder_id'
      AND NOT attisdropped AND atttypid <> 'uuid'::regtype
  ) THEN
    RAISE EXCEPTION 'chat_sessions.folder_id exists with unexpected type';
  END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS experience.chat_folders (
  id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT chat_folders_pkey PRIMARY KEY,
  user_id uuid NOT NULL CONSTRAINT chat_folders_user_fkey REFERENCES app_core.users(id) ON DELETE CASCADE,
  name text NOT NULL CONSTRAINT chat_folders_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 供 chat_sessions 的复合 FK 引用：数据库层保证对话只能放进同一用户的分组。
  CONSTRAINT chat_folders_user_id_key UNIQUE (user_id, id),
  -- 同一用户不重名；同时充当按用户列分组的索引。
  CONSTRAINT chat_folders_user_name_key UNIQUE (user_id, name)
);
ALTER TABLE experience.chat_folders OWNER TO postgres;
ALTER TABLE experience.chat_folders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_folders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON experience.chat_folders TO service_role;
COMMENT ON TABLE experience.chat_folders IS
  '用户自建的对话分组。删分组不删对话（chat_sessions.folder_id 置空）；每用户上限 20 个由 Backend 校验；随用户删除级联。';
COMMENT ON COLUMN experience.chat_folders.name IS '分组名，trim 后 1–12 字，同一用户内唯一。';

ALTER TABLE experience.chat_sessions ADD COLUMN IF NOT EXISTS folder_id uuid;
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'experience.chat_sessions'::regclass AND conname = 'chat_sessions_folder_fkey'
  ) THEN
    -- 列级 SET NULL：删分组只清 folder_id，不能把 user_id 一起置空。
    ALTER TABLE experience.chat_sessions
      ADD CONSTRAINT chat_sessions_folder_fkey FOREIGN KEY (user_id, folder_id)
      REFERENCES experience.chat_folders (user_id, id) ON DELETE SET NULL (folder_id);
  END IF;
END $fk$;
COMMENT ON COLUMN experience.chat_sessions.folder_id IS
  '用户放入的分组；NULL = 未分组。复合 FK 保证只能引用本人的分组，删分组时置空。';

-- 分组内列表与 FK 置空查找共用；未分组/全部仍走 idx_chat_sessions_user_pinned_recent。
-- 现存约 2 万行且建索引时没有匹配行，非并发构建只在极短时间内阻塞写入。
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_folder_recent
  ON experience.chat_sessions (
    user_id,
    folder_id,
    pinned_at DESC NULLS LAST,
    last_message_at DESC NULLS LAST,
    created_at DESC
  )
  WHERE deleted_at IS NULL AND folder_id IS NOT NULL;

-- 标签栏的数量：口径与列表一致（未软删、message_count > 0）。PostgREST 默认不开聚合，用函数一次往返。
CREATE OR REPLACE FUNCTION experience.chat_folder_summary(p_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog SET statement_timeout = '3s' AS $fn$
  WITH counts AS (
    SELECT s.folder_id, count(*)::int AS n
    FROM experience.chat_sessions s
    WHERE s.user_id = p_user_id AND s.deleted_at IS NULL AND s.message_count > 0
    GROUP BY s.folder_id
  )
  SELECT jsonb_build_object(
    'all', COALESCE((SELECT sum(n) FROM counts), 0)::int,
    'ungrouped', COALESCE((SELECT n FROM counts WHERE folder_id IS NULL), 0),
    'folders', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', f.id, 'name', f.name, 'session_count', COALESCE(c.n, 0), 'created_at', f.created_at)
        ORDER BY f.created_at, f.id
      )
      FROM experience.chat_folders f
      LEFT JOIN counts c ON c.folder_id = f.id
      WHERE f.user_id = p_user_id
    ), '[]'::jsonb)
  );
$fn$;

-- 按角色归拢：每个角色一行，代表段是该角色「最新」的一段（点卡片接着聊的就是它）；
-- 角色里任意一段置顶即整组置顶。排序：置顶的角色在前（最近置顶优先），其余按最新一段的时间。
-- p_folder_id 与 p_ungrouped 都为空/false 时是全部对话。
CREATE OR REPLACE FUNCTION experience.list_chat_session_groups(
  p_user_id uuid, p_folder_id uuid, p_ungrouped boolean, p_limit integer, p_offset integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog SET statement_timeout = '3s' AS $fn$
  WITH base AS (
    SELECT s.*
    FROM experience.chat_sessions s
    WHERE s.user_id = p_user_id AND s.deleted_at IS NULL AND s.message_count > 0
      AND (p_folder_id IS NULL OR s.folder_id = p_folder_id)
      AND (NOT COALESCE(p_ungrouped, false) OR s.folder_id IS NULL)
  ), ranked AS (
    SELECT b.*,
      row_number() OVER (
        PARTITION BY b.character_id
        ORDER BY b.last_message_at DESC NULLS LAST, b.created_at DESC, b.id
      ) AS group_rank,
      count(*) OVER (PARTITION BY b.character_id)::int AS group_size,
      max(b.pinned_at) OVER (PARTITION BY b.character_id) AS group_pinned_at
    FROM base b
  ), leads AS (
    SELECT * FROM ranked WHERE group_rank = 1
  ), page AS (
    SELECT * FROM leads
    ORDER BY group_pinned_at DESC NULLS LAST, last_message_at DESC NULLS LAST, created_at DESC, id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'groups', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'session', to_jsonb(p) - 'group_rank' - 'group_size' - 'group_pinned_at',
          'session_count', p.group_size,
          'pinned_at', p.group_pinned_at
        )
        ORDER BY p.group_pinned_at DESC NULLS LAST, p.last_message_at DESC NULLS LAST, p.created_at DESC, p.id
      )
      FROM page p
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM leads)::int
  );
$fn$;

ALTER FUNCTION experience.chat_folder_summary(uuid) OWNER TO postgres;
ALTER FUNCTION experience.list_chat_session_groups(uuid, uuid, boolean, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.chat_folder_summary(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.list_chat_session_groups(uuid, uuid, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.chat_folder_summary(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION experience.list_chat_session_groups(uuid, uuid, boolean, integer, integer) TO service_role;
COMMENT ON FUNCTION experience.chat_folder_summary(uuid) IS
  '对话页标签栏数量：全部、未分组与各分组的对话数（未软删且 message_count > 0）。';
COMMENT ON FUNCTION experience.list_chat_session_groups(uuid, uuid, boolean, integer, integer) IS
  '对话页「按角色」：每角色一行（代表段为最新一段）+ 段数 + 整组置顶时间；置顶角色在前，其余按最新一段时间，按角色分页。';

DO $verify$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'experience.chat_folders'::regclass)
    OR has_table_privilege('anon', 'experience.chat_folders', 'SELECT')
    OR has_table_privilege('authenticated', 'experience.chat_folders', 'SELECT')
    OR NOT has_table_privilege('service_role', 'experience.chat_folders', 'INSERT')
    OR has_function_privilege('anon', 'experience.chat_folder_summary(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'experience.list_chat_session_groups(uuid,uuid,boolean,integer,integer)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'experience.list_chat_session_groups(uuid,uuid,boolean,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'chat folder permission verification failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'experience.chat_sessions'::regclass AND conname = 'chat_sessions_folder_fkey' AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%ON DELETE SET NULL (folder_id)%'
  ) THEN
    RAISE EXCEPTION 'chat_sessions_folder_fkey missing or not column-scoped';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';
COMMIT;
