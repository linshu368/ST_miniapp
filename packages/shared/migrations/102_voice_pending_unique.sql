-- 102_voice_pending_unique.sql
--
-- 重新生成失败时保留上一版可播音频（需求 Q3）。
--
-- 现状（080 起）：uq_chat_message_audio_active 是 (message_id) WHERE is_active 的部分唯一索引，
-- 一条消息同时只能有一个生效版本。createPending 受理时把旧 ready 置 inactive、新 pending 置 active，
-- 失败后 markFailed 不改 is_active，于是 failed 行成了唯一生效行，前端拿不到上一版可播音频。
--
-- 修复口径：失败不让位。createPending 对旧 ready 行不再置 inactive，新 pending 行 is_active=false。
-- 这样 uq_chat_message_audio_active 不再能拦住「连点两下」（两个 pending 都 inactive），
-- 必须新增 (message_id) WHERE status='pending' 的部分唯一索引接手并发保护。
-- 同时 GET 要按会话读 inactive 的 pending / failed 行（用于组合 last_error_code），
-- 现有 idx_chat_message_audio_session 是 WHERE is_active 的部分索引，覆盖不到，需补一个非部分索引。
--
-- 不动 uq_chat_message_audio_active：成功时 markReady 仍走「先把旧 active 置否、再标新行 active」，
-- 该索引继续保证一条消息至多一个生效版本。

BEGIN;

-- 一条消息同时只能有一个 pending。连点两下时第二个 insert 撞 23505，
-- 由 createPending 翻译成 already_generating，与原 active 索引的拦截语义一致。
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_audio_pending
  ON miniapp.chat_message_audio (message_id)
  WHERE status = 'pending';

-- 会话语音读路径要取该会话全部行（含 inactive 的 pending / failed），
-- 用于在已有可播时把本次失败码组合进 last_error_code。
-- 现有 idx_chat_message_audio_session 是 WHERE is_active 的部分索引，不够。
CREATE INDEX IF NOT EXISTS idx_chat_message_audio_session_all
  ON miniapp.chat_message_audio (session_id, message_id);

COMMIT;

NOTIFY pgrst, 'reload schema';
