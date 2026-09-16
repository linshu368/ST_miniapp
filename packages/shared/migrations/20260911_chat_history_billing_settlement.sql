-- 20260911_chat_history_billing_settlement.sql
-- domain: experience（见 docs/ARCHITECTURE.md §1 铁律 8 与 §4.5）
--
-- A：结算完成态可恢复。chat_history 原先只有用量元数据是否齐全，
-- 短暂扣费失败后会出现「元数据齐了、账没结」，回捞扫不到、也无法按请求时定价补建。
--
-- 两列只表达两件事实，不改扣费口径：
--   llm_billing_snapshot    请求时定价快照；无 charge 行时按它重建，不重新定价
--   llm_billing_settled_at  结算完成（扣费行存在、额度已收口、金额已回写）
--
-- 元数据补齐 ≠ 结算完成。回捞扫描两者分开看。
-- 不回填存量；24h 窗口内未写快照的旧行仍只按用量字段不全回捞。
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。
-- 前置：099（chat_history 已在 experience）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.chat_history
  ADD COLUMN IF NOT EXISTS llm_billing_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS llm_billing_settled_at timestamptz;

COMMENT ON COLUMN experience.chat_history.llm_billing_snapshot IS
  '请求时 LLM 定价快照。回捞按此补建 charge，不重新定价。';
COMMENT ON COLUMN experience.chat_history.llm_billing_settled_at IS
  '结算完成时间。NULL 表示扣费行 / 额度收口 / 金额回写尚未齐。';

COMMIT;

NOTIFY pgrst, 'reload schema';
