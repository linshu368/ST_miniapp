-- Move customer-support reply notifications out of the message center and onto the
-- "contact support" entry, backed by a server-side per-user read watermark.

BEGIN;

ALTER TABLE miniapp.support_conversations
  ADD COLUMN IF NOT EXISTS user_last_read_at TIMESTAMPTZ;

COMMENT ON COLUMN miniapp.support_conversations.user_last_read_at IS
  '用户最后一次打开客服聊天页的时间；晚于它的客服消息即为未读，红点以此为准。';

-- 历史遗留：客服回复曾经写入过消息中心的「消息」列表。这些条目在 MiniApp 里点不进会话，
-- 与新的红点入口重复，直接软删除，避免和 support_conversations 的未读状态各说各话。
UPDATE miniapp.notifications
SET deleted_at = now(),
    is_published = false,
    updated_at = now()
WHERE scope = 'personal'
  AND category = 'system'
  AND title = '客服已回复你的问题'
  AND deleted_at IS NULL;

COMMIT;
