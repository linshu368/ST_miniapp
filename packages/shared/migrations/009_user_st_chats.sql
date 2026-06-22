-- 009: 分区 B - 用户聊天记录镜像（资产型，占位）
--
-- 分区归属：B 类（用户运行时数据）
-- 形态：资源型-用户池（设计文档第 103 行 + DECISIONS.md D007）
-- 数据流：ST 文件系统 → Supabase（异步镜像，反向同步）
--
-- 阶段一定位：占位最小结构
--   - 阶段一仅建表，不实现具体同步逻辑
--   - 阶段二接入 PostMessage 后扩展字段并实现镜像
--
-- 决策依据：
--   - DECISIONS.md D007：用户池资源占位，阶段一不实现具体同步
--   - 跨 schema FK：character_id → miniapp.characters（D003 + D010）
--     用户切到 ST 私有卡时记 NULL（D007）

CREATE TABLE IF NOT EXISTS st_users.user_st_chats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- 跨 schema FK 到平台卡池。用户切换到 ST 私有卡时记 NULL（D007）
  character_id    UUID REFERENCES miniapp.characters(id) ON DELETE SET NULL,

  -- 聊天数据 jsonb（阶段二定义具体结构，阶段一只占位）
  chat_data       JSONB NOT NULL DEFAULT '[]',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 索引（占位，阶段二可能调整） ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_st_chats_user
  ON st_users.user_st_chats(user_id);

CREATE INDEX IF NOT EXISTS idx_user_st_chats_user_character
  ON st_users.user_st_chats(user_id, character_id)
  WHERE character_id IS NOT NULL;

-- ─── 注释（三标签视图） ──────────────────────────────────────────────────
COMMENT ON TABLE st_users.user_st_chats IS
  '[partition=B][shape=resource:user_pool][direction=up] 用户 ST 聊天记录的 Supabase 镜像。'
  '阶段一占位最小结构，阶段二接入 PostMessage 后扩展字段。详见 DECISIONS.md D007';

COMMENT ON COLUMN st_users.user_st_chats.character_id IS
  '跨 schema FK 到 miniapp.characters。用户切到 ST 私有卡时记 NULL（D007）';
