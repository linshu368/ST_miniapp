-- 092: 删 miniapp.chat_history 的三个死列。依据见 docs/schema划分专项.md §2。
--
--   preset_id            ST 时代的预设外键。自研链路恒写 null，两库实测全空，零读取。
--                        （指向 st_platform.platform_presets 的 FK 已随 088 drop schema 一起消失。）
--   llm_model_markup     计费加成倍数快照。等值数据在 llm_usage_charges.model_markup，零读取。
--   user_character_round 用户 × 角色累计轮次。零读取（大厅排序明确弃用它，改按窗口内行数），
--                        且它由每次 INSERT 触发一次 MAX+1 全表聚合，删列同时卸掉这份写放大。
--
-- 连带对象：
--   * 触发器 trg_set_user_character_round 与函数 tf_set_user_character_round 一并删除。
--   * 索引 idx_chat_history_character_user_round (character_id, user_id, user_character_round)
--     随列自动消失。大厅排序走的是 idx_chat_history_character_user_created_at，不受影响。
--   * 视图 current_chat_history 建于 073、定义是 SELECT *，列已固化在 viewdef 里，
--     必须先 DROP 再按原样重建（重建后自动收敛为 29 列）。
--
-- 执行前必须在**生产**核对库内消费方（test 库没有这些对象，核对不出来）：
--   SELECT n.nspname || '.' || p.proname
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
--      AND p.prosrc ~ '(user_character_round|preset_id|llm_model_markup)';
--   SELECT n.nspname || '.' || c.relname
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE c.relkind IN ('v','m')
--      AND pg_get_viewdef(c.oid) ~ '(user_character_round|preset_id|llm_model_markup)';
--   SELECT jobid, command FROM cron.job
--    WHERE command ~ '(user_character_round|preset_id|llm_model_markup)';
-- 预期只命中 miniapp.tf_set_user_character_round 与 miniapp.current_chat_history 两个
-- （本迁移会处理它们）。多出任何一个就停下来，先写清消费方。
--
-- DROP COLUMN 只改 catalog、不重写 10 GB 的表，但要拿 chat_history 的 ACCESS EXCLUSIVE 锁，
-- 因此设 lock_timeout 让抢不到锁时快速失败，而不是堵住持续写入的对话链路。
-- 幂等：IF EXISTS。

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP VIEW IF EXISTS miniapp.current_chat_history;

DROP TRIGGER IF EXISTS trg_set_user_character_round ON miniapp.chat_history;
DROP FUNCTION IF EXISTS miniapp.tf_set_user_character_round();

ALTER TABLE miniapp.chat_history
  DROP COLUMN IF EXISTS preset_id,
  DROP COLUMN IF EXISTS llm_model_markup,
  DROP COLUMN IF EXISTS user_character_round;

-- 与 073 逐字一致，只是重新展开 *。
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

-- 验证：
--   -- chat_history 应为 29 列，且下面三行返回 0 行
--   SELECT attname FROM pg_attribute
--    WHERE attrelid = 'miniapp.chat_history'::regclass AND attnum > 0 AND NOT attisdropped
--      AND attname IN ('preset_id','llm_model_markup','user_character_round');
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'miniapp.chat_history'::regclass AND tgname = 'trg_set_user_character_round';
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'miniapp' AND indexname = 'idx_chat_history_character_user_round';
--   -- 视图应为 29 列并可查
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'miniapp' AND table_name = 'current_chat_history';
