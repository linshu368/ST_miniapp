-- 078_chat_session_pinned.sql
--
-- 历史聊天页要支持置顶。置顶是用户级的持久状态，不能只存在前端本地——
-- 换设备、清缓存都得保留，而且 /chats 与角色内的对话抽屉读的是同一份列表，
-- 状态必须同源。
--
-- 用时间戳而不是布尔：多次置顶时「最近置顶的排最前」是符合直觉的次序，
-- 布尔值只能靠 last_message_at 兜底，置顶顺序会被新消息打乱。

BEGIN;

ALTER TABLE miniapp.chat_sessions
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

COMMENT ON COLUMN miniapp.chat_sessions.pinned_at IS
  '用户置顶该会话的时间；NULL = 未置顶。列表按 pinned_at DESC NULLS LAST 优先，同为置顶时最近置顶的在前。';

-- 会话列表（/chats 与角色内抽屉）只取 message_count > 0：进角色卡就会建会话，
-- 一句话没发的那些不该出现在「历史聊天」里。这是产品口径，不是表约束——
-- 统计会话数、做数据清理、排查某用户会话量时都要带上同一个条件，否则口径对不上。
-- 建会话时会复用已有的空会话，所以同一用户 × 同一角色最多留一行 message_count = 0。
COMMENT ON COLUMN miniapp.chat_sessions.message_count IS
  '该会话已完成的轮次数，由触发器维护。列表口径：message_count > 0 才对用户可见。';

-- 069 建的 idx_chat_sessions_user_recent 头两列是 (user_id, last_message_at)，
-- 排序键前面插了 pinned_at 之后走不了它，需要一条新的覆盖顺序。
-- 旧索引保留：按角色过滤的抽屉查询仍会用到，且它是 069 的既有资产，
-- 这次只加不减，回滚时不需要重建。
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_pinned_recent
  ON miniapp.chat_sessions (
    user_id,
    pinned_at DESC NULLS LAST,
    last_message_at DESC NULLS LAST,
    created_at DESC
  )
  WHERE deleted_at IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
