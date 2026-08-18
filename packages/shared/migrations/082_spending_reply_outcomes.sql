-- 082_spending_reply_outcomes.sql
-- Keep accounting labels experience-based and reopen resolvable null finish reasons as pending.

BEGIN;

UPDATE miniapp.llm_usage_charges AS charge
SET metadata = COALESCE(charge.metadata, '{}'::JSONB) || jsonb_build_object(
  'generation_status', history.status,
  'reply_outcome', CASE
    WHEN COALESCE(trim(history.assistant_reply), '') = '' THEN 'empty'
    WHEN history.status = 'success'
      AND (history.llm_finish_reason = 'stop' OR history.llm_finish_reason IS NULL)
      THEN 'complete'
    ELSE 'incomplete'
  END,
  'reply_char_count', char_length(COALESCE(history.assistant_reply, ''))
)
FROM miniapp.chat_history AS history
WHERE history.llm_charge_id = charge.charge_key
  AND (COALESCE(charge.metadata, '{}'::JSONB) ->> 'reply_outcome') IS NULL;

-- 081 treated stream_interrupted + null finish_reason as immediately non-billable.
-- If OpenRouter supplied a generation id, keep it pending until the real finish_reason arrives.
UPDATE miniapp.llm_usage_charges AS charge
SET status = 'pending',
    metadata = COALESCE(charge.metadata, '{}'::JSONB) || jsonb_build_object(
      'chat_status', 'success',
      'billing_gate', 'pending_finish_reason',
      'difference_reason', 'awaiting_finish_reason'
    )
FROM miniapp.chat_history AS history
WHERE history.llm_charge_id = charge.charge_key
  AND charge.status = 'failed'
  AND charge.generation_id IS NOT NULL
  AND charge.debit_ledger_id IS NULL
  AND charge.charged_amount = 0
  AND (COALESCE(charge.metadata, '{}'::JSONB) ->> 'billing_mode') = 'fixed_tier'
  AND (COALESCE(charge.metadata, '{}'::JSONB) ->> 'finish_reason') IS NULL
  AND history.llm_finish_reason IS NULL
  AND history.status = 'stream_interrupted';

COMMIT;
