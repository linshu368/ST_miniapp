-- domain: experience
-- Local delivery only. Execute one file at a time after the release checklist gates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- DESTRUCTIVE, separate approval/window required. The SQL cannot certify deployed SHA,
-- old-replica exit, external consumers, no legacy writes, or reviewed historical classification.
-- Require those four evidence gates in production-release-checklist.md BEFORE this file.
DO $$
DECLARE present integer;
BEGIN
  SELECT count(*) INTO present FROM pg_attribute WHERE attrelid='experience.chat_history'::regclass
    AND attname=ANY(ARRAY['llm_provider_name', 'llm_usage', 'llm_usage_cache', 'llm_native_tokens_cached', 'llm_native_tokens_reasoning', 'llm_native_tokens_completion', 'llm_native_tokens_prompt', 'llm_latency', 'llm_generation_time', 'llm_model', 'llm_generation_id', 'llm_generation_data']) AND attnum>0 AND NOT attisdropped;
  IF present<>12 THEN RAISE EXCEPTION 'Expected exactly 12 legacy columns; inspect shape/ledger before retry'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_depend d ON d.refclassid='pg_class'::regclass AND d.refobjid=a.attrelid AND d.refobjsubid=a.attnum
    WHERE a.attrelid='experience.chat_history'::regclass AND a.attname=ANY(ARRAY['llm_provider_name', 'llm_usage', 'llm_usage_cache', 'llm_native_tokens_cached', 'llm_native_tokens_reasoning', 'llm_native_tokens_completion', 'llm_native_tokens_prompt', 'llm_latency', 'llm_generation_time', 'llm_model', 'llm_generation_id', 'llm_generation_data']) AND NOT a.attisdropped)
    THEN RAISE EXCEPTION 'Legacy column database dependency remains'; END IF;
  IF EXISTS (SELECT 1 FROM experience.openrouter_chat_history o JOIN experience.venice_chat_history v USING(chat_history_id))
    THEN RAISE EXCEPTION 'Provider overlap'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
    WHERE (h.llm_generation_id IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_generation_id IS DISTINCT FROM h.llm_generation_id ELSE o.llm_generation_id IS DISTINCT FROM h.llm_generation_id END)
      OR (h.llm_provider_name IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_provider_name IS NULL ELSE o.provider_name IS NULL END) OR
      (h.llm_usage IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_usage IS NULL ELSE o.usage IS NULL END) OR
      (h.llm_usage_cache IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_usage_cache IS NULL ELSE o.usage_cache IS NULL END) OR
      (h.llm_native_tokens_cached IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_native_tokens_cached IS NULL ELSE o.native_tokens_cached IS NULL END) OR
      (h.llm_native_tokens_reasoning IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_native_tokens_reasoning IS NULL ELSE o.native_tokens_reasoning IS NULL END) OR
      (h.llm_native_tokens_completion IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_native_tokens_completion IS NULL ELSE o.native_tokens_completion IS NULL END) OR
      (h.llm_native_tokens_prompt IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_native_tokens_prompt IS NULL ELSE o.native_tokens_prompt IS NULL END) OR
      (h.llm_latency IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_latency IS NULL ELSE o.latency IS NULL END) OR
      (h.llm_generation_time IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_generation_time IS NULL ELSE o.generation_time IS NULL END) OR
      (h.llm_model IS NOT NULL AND CASE WHEN v.chat_history_id IS NOT NULL THEN v.llm_model IS NULL ELSE o.model IS NULL END))
    THEN RAISE EXCEPTION 'Unpreserved identity/scalars or unresolved provider; classify/catch-up first'; END IF;
  -- Unknown diagnostic content must be explicitly reviewed, never blindly copied/discarded.
  IF EXISTS (SELECT 1 FROM experience.chat_history WHERE llm_generation_data IS NOT NULL)
    THEN RAISE EXCEPTION 'Legacy diagnostic JSON requires separate reviewed disposal before DROP'; END IF;
  -- New column-free calls can be streaming during contract: they own durable detail
  -- rows and have no legacy values to remove. Only unresolved legacy/missing-detail
  -- cohorts block this gate; do not require interrupting healthy new conversations.
  IF EXISTS (SELECT 1 FROM experience.chat_history h
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
    WHERE h.llm_charge_id IS NOT NULL AND h.llm_billing_settled_at IS NULL AND (
      h.llm_provider_name IS NOT NULL OR
      h.llm_usage IS NOT NULL OR
      h.llm_usage_cache IS NOT NULL OR
      h.llm_native_tokens_cached IS NOT NULL OR
      h.llm_native_tokens_reasoning IS NOT NULL OR
      h.llm_native_tokens_completion IS NOT NULL OR
      h.llm_native_tokens_prompt IS NOT NULL OR
      h.llm_latency IS NOT NULL OR
      h.llm_generation_time IS NOT NULL OR
      h.llm_model IS NOT NULL OR
      h.llm_generation_id IS NOT NULL OR
      h.llm_generation_data IS NOT NULL OR
      o.chat_history_id IS NULL AND v.chat_history_id IS NULL))
    THEN RAISE EXCEPTION 'Historical billing/quota closure not proven'; END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='experience.chat_history'::regclass AND NOT attisdropped
    AND attname=ANY(ARRAY['llm_finish_reason','model','llm_charge_id','llm_billing_snapshot','llm_billing_settled_at','llm_intended_deduction','deduction_rate']))<>7
    THEN RAISE EXCEPTION 'Business/billing shape mismatch'; END IF;
END $$;
ALTER TABLE experience.chat_history
  DROP COLUMN llm_provider_name RESTRICT,
  DROP COLUMN llm_usage RESTRICT,
  DROP COLUMN llm_usage_cache RESTRICT,
  DROP COLUMN llm_native_tokens_cached RESTRICT,
  DROP COLUMN llm_native_tokens_reasoning RESTRICT,
  DROP COLUMN llm_native_tokens_completion RESTRICT,
  DROP COLUMN llm_native_tokens_prompt RESTRICT,
  DROP COLUMN llm_latency RESTRICT,
  DROP COLUMN llm_generation_time RESTRICT,
  DROP COLUMN llm_model RESTRICT,
  DROP COLUMN llm_generation_id RESTRICT,
  DROP COLUMN llm_generation_data RESTRICT;
NOTIFY pgrst,'reload schema';
COMMIT;
-- Old Backend rollback is incompatible. Use a tested column-free SHA or reviewed forward-fix.
-- DROP COLUMN does not reclaim disk immediately. No VACUUM FULL/table rewrite.
