-- 023: Move wish pool from Telegram Bot session flow to MiniApp UI.
--
-- 目标：
--   - 删除旧 Bot 对话状态表
--   - 保留 miniapp.wish_roles 作为 MiniApp 内许愿池数据表

DROP TABLE IF EXISTS miniapp.wish_role_sessions;

COMMENT ON TABLE miniapp.wish_roles IS
  'MiniApp 私密角色许愿记录，供运营用 SQL 查询消费。';
