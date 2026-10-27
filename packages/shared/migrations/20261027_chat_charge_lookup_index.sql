-- domain: experience owns reply identity; billing reads its charge identity.
-- Online, additive repair for chat_delivery_billing_gate's high-frequency lookup.
-- Run without BEGIN: CONCURRENTLY must not hold a write-blocking table lock.
-- A failed/invalid build must be inspected before any retry or removal.
SET lock_timeout = '5s';
SET statement_timeout = '5min';
SET maintenance_work_mem = '32MB';
SET max_parallel_maintenance_workers = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_history_llm_charge_id
  ON experience.chat_history (llm_charge_id)
  WHERE llm_charge_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'llm_charge_id'
    WHERE i.indexrelid = 'experience.idx_chat_history_llm_charge_id'::regclass
      AND i.indrelid = 'experience.chat_history'::regclass
      AND i.indisvalid AND i.indisready AND NOT i.indisunique
      AND am.amname = 'btree' AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND i.indkey[0] = a.attnum AND i.indexprs IS NULL
      AND pg_get_expr(i.indpred, i.indrelid) = '(llm_charge_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'Charge lookup index is invalid or has unexpected shape; inspect before recovery';
  END IF;
END;
$$;
COMMENT ON INDEX experience.idx_chat_history_llm_charge_id IS
  'Bounds delivery/billing qualification by charge identity; avoids scanning all chat history on settlement.';
