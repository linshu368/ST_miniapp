-- 022: Remove MiniApp credit deduction remnants.
--
-- 目标：
--   - 清理已执行环境中的聊天扣费表、扣费 RPC 和扣费配置
--   - 保留充值、签到奖励、许愿奖励和钱包余额展示

DROP FUNCTION IF EXISTS miniapp.deduct_wallet_credits(UUID, INTEGER);
DROP FUNCTION IF EXISTS miniapp.charge_chat_message(UUID, UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS miniapp.reserve_chat_message(UUID, UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS miniapp.finalize_chat_message_charge(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS miniapp.refund_chat_message_charge(UUID, UUID, TEXT, TEXT);

DROP TABLE IF EXISTS miniapp.chat_message_charges;

DELETE FROM miniapp.runtime_config
WHERE key IN (
  'miniapp_chat_message_credit_cost',
  'miniapp_model_tier_credit_costs'
);

WITH chat_deductions AS (
  SELECT
    user_id,
    GREATEST(-SUM(main_delta), 0)::INTEGER AS restore_main,
    GREATEST(-SUM(bonus_delta), 0)::INTEGER AS restore_bonus
  FROM miniapp.wallet_ledger
  WHERE entry_type IN ('chat_debit', 'refund')
    AND reference_type = 'chat_message'
  GROUP BY user_id
)
UPDATE miniapp.user_wallets AS wallet
SET
  main_credits = wallet.main_credits + chat_deductions.restore_main,
  bonus_credits = wallet.bonus_credits + chat_deductions.restore_bonus,
  updated_at = now()
FROM chat_deductions
WHERE wallet.user_id = chat_deductions.user_id
  AND (chat_deductions.restore_main > 0 OR chat_deductions.restore_bonus > 0);

DELETE FROM miniapp.wallet_ledger
WHERE entry_type IN ('chat_debit', 'refund')
  AND reference_type = 'chat_message';

ALTER TABLE miniapp.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;

ALTER TABLE miniapp.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('recharge', 'adjustment', 'checkin_bonus', 'wish_reward'));

COMMENT ON TABLE miniapp.wallet_ledger IS
  'MiniApp 独立钱包流水表，记录充值、奖励和运营调整。';
