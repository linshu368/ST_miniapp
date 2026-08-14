-- 会话 title 默认改为绑定角色的 characters.name。
-- 旧契约：NULL = 未重命名，前端用 last_message_preview 当标题。
-- 新契约：创建时写入角色名；用户重命名后为实值；清空重命名恢复为当前角色名。
-- UI 截断到 7 个字符，由前端 resolveSessionTitle 负责，本迁移只回填存量。

BEGIN;

UPDATE miniapp.chat_sessions AS s
SET title = left(btrim(c.name), 60)
FROM miniapp.characters AS c
WHERE s.character_id = c.id
  AND s.title IS NULL
  AND btrim(COALESCE(c.name, '')) <> '';

UPDATE miniapp.chat_sessions
SET title = '新的对话'
WHERE title IS NULL OR btrim(title) = '';

COMMENT ON COLUMN miniapp.chat_sessions.title IS
  '会话显示名。创建时默认写入绑定角色的 characters.name；用户重命名后为实值；清空重命名则恢复为当前角色名。UI 只展示前 7 个字符。';

COMMIT;
