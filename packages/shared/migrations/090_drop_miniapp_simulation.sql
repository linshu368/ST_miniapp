-- 090: 下线 miniapp_simulation（评测会话 / 聊天日志）。
--
-- Railway 上的 simulation 独立 project 已于 2026-08-20 停用。
-- 生产 2 张表（chat_log / conversations）+ 触发器函数 tf_set_round_index；
-- 两条 FK 指向 miniapp.characters（子表在 simulation 侧，drop 方向安全）。
-- 最后写入 2026-08-05，统计窗口内零读写。
--
-- 不要顺手删 miniapp.characters.is_test：pg_cron job 5
-- （card_position_hourly_snapshot）还在用这一列。
--
-- 数据留档不进 git（chat_log 约 104 MB）：执行前 COPY 到
-- /tmp/st-schema-archive/{prod,test}/miniapp_simulation.*
--
-- 幂等：IF EXISTS。

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP SCHEMA IF EXISTS miniapp_simulation CASCADE;

COMMIT;

-- 验证：
--   SELECT nspname FROM pg_namespace WHERE nspname = 'miniapp_simulation';  -- 0 行
--   SELECT attname FROM pg_attribute a
--     JOIN pg_class c ON c.oid = a.attrelid
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'miniapp' AND c.relname = 'characters' AND attname = 'is_test';
--   -- is_test 必须仍在
