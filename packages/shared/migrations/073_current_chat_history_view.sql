-- 每个 session turn 的当前 revision 读模型。
-- 把 DISTINCT ON 固定在数据库侧，避免会话详情为了取 50 个 turn 把全部历史 revision 拉回应用层。

BEGIN;

CREATE OR REPLACE VIEW miniapp.current_chat_history
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (session_id, turn_index) *
FROM miniapp.chat_history
WHERE session_id IS NOT NULL
  AND turn_index IS NOT NULL
  AND revision IS NOT NULL
ORDER BY session_id, turn_index, revision DESC;

REVOKE ALL ON miniapp.current_chat_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON miniapp.current_chat_history TO service_role, postgres;

COMMENT ON VIEW miniapp.current_chat_history IS
  '自研会话每个 turn 的当前版本（max revision）；旧 revision 仍保留在 chat_history 供审计。';

COMMIT;

NOTIFY pgrst, 'reload schema';
