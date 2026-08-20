-- 089: 下线 growth 整条归因链路（3 表 + 1 视图）。
--
-- 生产三张表全为 0 行。前端启动打的 POST /api/growth/miniapp-entry 走的是
-- miniapp_traffic.botlinks + miniapp.users.source_id + miniapp_traffic.increment_click，
-- 一行 growth.* 都没用到。
--
-- 代码同批摘掉：
--   · GET/POST /api/cs/growth/channel-links（CS 无消费页）
--   · GET /api/growth/click/:sourceId（302 重定向，写 growth.link_clicks）
-- POST /api/growth/miniapp-entry 保留，本迁移不改它。
--
-- 唯一的库内外部引用 admin.get_analytics_dashboard 已在 087 删除。
-- FK 都在 growth 侧，CASCADE 不会碰到 miniapp / miniapp_traffic。
--
-- 幂等：IF EXISTS。test 库从未跑过 029，本文件是 no-op。

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP SCHEMA IF EXISTS growth CASCADE;

COMMIT;

-- 验证：
--   SELECT nspname FROM pg_namespace WHERE nspname = 'growth';  -- 0 行
