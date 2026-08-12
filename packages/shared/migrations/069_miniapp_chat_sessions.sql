-- 自研引擎对话数据模型（M1）：会话表 + 消息表 + chat_history 升维。
--
-- 方案：docs/ST_remove-MVP实施方案.md §五。
-- 归属 miniapp schema，与 chat_history / characters / miniapp_user_settings 同域；
-- st_* 三个 schema 是 ST 同步层，替换完成后要整体归档，新链路不落在那里。
--
-- 实测前提（2026-08-10 对 test 库 zoqelpfhurwehlvypryl 查证）：
--   chat_history.user_id 的 FK 在 028 已改指 miniapp.users(id) ON DELETE CASCADE，
--   不再指向 public.users。本迁移的两张新表跟随同一指向。
--
-- system prompt 不入库：每次生成现场组装，预设/模板更新后历史会话自动跟随。

BEGIN;

-- ─── 会话表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp.chat_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  character_id         UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE RESTRICT,

  -- NULL = 未重命名，前端按首条用户消息生成显示名
  title                TEXT,

  -- 侧边栏列表用的冗余字段，避免每次聚合 messages。
  -- 三个字段一律由 trg_refresh_chat_session_stats 维护，应用层不直接写。
  last_message_at      TIMESTAMPTZ,
  last_message_preview TEXT,
  message_count        INTEGER NOT NULL DEFAULT 0,

  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_recent
  ON miniapp.chat_sessions(user_id, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_character_recent
  ON miniapp.chat_sessions(user_id, character_id, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE miniapp.chat_sessions IS
  '自研引擎对话会话。用户 × 角色可多会话（决策 9）。运行时真相，替代 ST 文件系统 chats/。';
COMMENT ON COLUMN miniapp.chat_sessions.title IS
  'NULL = 用户未重命名，前端按首条用户消息截断显示；重命名后为实值。';
COMMENT ON COLUMN miniapp.chat_sessions.message_count IS
  '当前生效（is_active）消息条数，由 trg_refresh_chat_session_stats 维护；重生成不增加计数。';

-- ─── 消息表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miniapp.chat_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES miniapp.chat_sessions(id) ON DELETE CASCADE,

  -- 一问一答共用同一个 turn_index；开场白独占 turn_index=0 且该轮无 user 行
  turn_index          INTEGER NOT NULL CHECK (turn_index >= 0),
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),

  -- 重生成版本：assistant 行从 0 递增；user 行恒为 0
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- 每个 (session, turn, role) 恰有一行 is_active = true
  is_active           BOOLEAN NOT NULL DEFAULT true,

  content             TEXT NOT NULL DEFAULT '',

  status              TEXT NOT NULL DEFAULT 'complete'
                      CHECK (status IN ('streaming', 'complete', 'interrupted', 'failed')),
  error_code          TEXT,
  finish_reason       TEXT,

  -- ─── 生成配置快照（决策 10）：仅 assistant 行填充 ───────────────────
  model_id            TEXT,    -- 目录 stable id
  model_openrouter_id TEXT,    -- 实际路由到的上游模型
  preset_id           UUID,    -- st_platform.platform_presets.id
  gen_config          JSONB,   -- UserGenerationConfig 快照

  charge_id           UUID,    -- miniapp.llm_usage_charges.charge_id
  generation_id       TEXT,    -- OpenRouter generation id

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- user 行没有生成过程，版本与状态都只有一种形态
  CONSTRAINT chat_messages_user_row_shape CHECK (
    role <> 'user' OR (revision = 0 AND status = 'complete')
  )
);

-- 同一轮同一角色只能有一个生效版本。并发重生成靠它拦截，不靠应用层判重。
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_active_turn
  ON miniapp.chat_messages(session_id, turn_index, role)
  WHERE is_active;

-- 版本唯一 + 审计回溯（列出某轮的全部历史版本）共用一条索引。
-- 方案原文另列了一条与 uq_chat_messages_active_turn 列与谓词完全相同的普通索引，
-- 那是纯冗余，这里换成覆盖 revision 的形态。
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_turn_revision
  ON miniapp.chat_messages(session_id, turn_index, role, revision);

COMMENT ON TABLE miniapp.chat_messages IS
  '自研引擎对话消息。system 段不入库，每次生成由角色卡+平台规则+用户配置现场组装。'
  '重生成保留历史版本（revision 递增），仅 is_active 行参与展示与上下文。';
COMMENT ON COLUMN miniapp.chat_messages.turn_index IS
  '一问一答共用同一个 turn_index；开场白是 turn 0 的 assistant 行且该轮无 user 行（决策 3）。';
COMMENT ON COLUMN miniapp.chat_messages.gen_config IS
  '生成时的 UserGenerationConfig 快照。改配置后历史输出仍可解释（总方案决策 10）。';

-- ─── 会话冗余字段维护 ───────────────────────────────────────────────────
-- 放在触发器里而不是应用层：message_count 是自增语义，PostgREST 写不出表达式更新，
-- 拆成读-改-写会在并发下丢计数。触发器与消息写入同事务，天然一致。
CREATE OR REPLACE FUNCTION miniapp.tf_refresh_chat_session_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session_id UUID := NEW.session_id;
BEGIN
  UPDATE miniapp.chat_sessions AS s
  SET message_count = stats.total,
      last_message_at = stats.last_at,
      last_message_preview = stats.preview,
      updated_at = now()
  FROM (
    SELECT
      count(*)::INTEGER AS total,
      max(m.created_at) AS last_at,
      (
        -- 取最后一条有正文的生效消息：流式占位行 content 为空，
        -- 生成期间预览应停留在用户那条，而不是被清空。
        SELECT left(btrim(regexp_replace(latest.content, '\s+', ' ', 'g')), 120)
        FROM miniapp.chat_messages AS latest
        WHERE latest.session_id = v_session_id
          AND latest.is_active
          AND btrim(latest.content) <> ''
        ORDER BY latest.turn_index DESC,
                 (CASE latest.role WHEN 'user' THEN 0 ELSE 1 END) DESC
        LIMIT 1
      ) AS preview
    FROM miniapp.chat_messages AS m
    WHERE m.session_id = v_session_id AND m.is_active
  ) AS stats
  WHERE s.id = v_session_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_chat_session_stats ON miniapp.chat_messages;
CREATE TRIGGER trg_refresh_chat_session_stats
AFTER INSERT OR UPDATE OF content, is_active, status ON miniapp.chat_messages
FOR EACH ROW EXECUTE FUNCTION miniapp.tf_refresh_chat_session_stats();

-- ─── 权限 ───────────────────────────────────────────────────────────────
ALTER TABLE miniapp.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.chat_sessions, miniapp.chat_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.chat_sessions, miniapp.chat_messages TO service_role, postgres;

-- ─── chat_history 升维（决策 2）───────────────────────────────────────
-- 只加 session_id，不加 assistant_message_id（本轮决策 2）。
ALTER TABLE miniapp.chat_history
  ADD COLUMN IF NOT EXISTS session_id UUID
    REFERENCES miniapp.chat_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_history_session
  ON miniapp.chat_history(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN miniapp.chat_history.session_id IS
  '自研引擎会话 id。存量行（ST 链路产生）为 NULL，切换后新写入必填。';

-- 不动 trg_set_user_character_round：语义保持「用户 × 角色累计轮次」、跨会话累加。
-- cs_platform.user_metrics 视图与首页推荐排序（060）都依赖它，改成 per-session 会打挂线上。

COMMIT;

NOTIFY pgrst, 'reload schema';
