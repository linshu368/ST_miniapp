-- 091: 删除已被 llm_usage_charges 取代的旧聊天扣费表、4 个 RPC、以及废弃的转化率视图。
--
-- miniapp.chat_message_charges：两库均 0 行且 n_tup_ins = 0，从未插入过。
-- 4 个 RPC 在 MiniappWalletRepository 有封装，全仓库无调用方。
-- miniapp.character_engagement_stats：060 建的，074 已换成 character_ranking_scores，
-- 代码与库内均零引用。
--
-- 不使用 CASCADE 删函数：签名写死，意外仍被依赖时应当报错而不是带走别的对象。
-- DROP TABLE 会解掉指向 miniapp.users / wallet_ledger 的 FK，热表上同样加 lock_timeout。
--
-- 幂等：IF EXISTS。

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS miniapp.charge_chat_message(UUID, UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS miniapp.reserve_chat_message(UUID, UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS miniapp.finalize_chat_message_charge(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS miniapp.refund_chat_message_charge(UUID, UUID, TEXT, TEXT);

DROP VIEW IF EXISTS miniapp.character_engagement_stats;

DROP TABLE IF EXISTS miniapp.chat_message_charges;

COMMIT;

-- 验证（均应 0 行）：
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'miniapp' AND relname IN ('chat_message_charges','character_engagement_stats');
--   SELECT proname FROM pg_proc
--    WHERE pronamespace = 'miniapp'::regnamespace
--      AND proname IN ('charge_chat_message','reserve_chat_message',
--                      'finalize_chat_message_charge','refund_chat_message_charge');
