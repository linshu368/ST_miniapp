-- 053_llm_spending_retention.sql
-- Record failed free-model calls at 0.0 and retain only each user's latest
-- 100 full spending rows. Minimal deduplication keys remain so pruned retries
-- can never charge the wallet again.

BEGIN;

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'miniapp.llm_usage_charges'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format(
      'ALTER TABLE miniapp.llm_usage_charges DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;

  ALTER TABLE miniapp.llm_usage_charges
    ADD CONSTRAINT llm_usage_charges_status_check CHECK (
      status IN (
        'pending', 'failed', 'free', 'charged',
        'partial', 'reconciled', 'historical'
      )
    );
END;
$$;

CREATE TABLE IF NOT EXISTS miniapp.llm_usage_charge_dedup (
  charge_key UUID PRIMARY KEY,
  generation_id TEXT,
  user_id UUID NOT NULL,
  charged_amount NUMERIC(14,1) NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_charge_dedup_generation
  ON miniapp.llm_usage_charge_dedup(generation_id)
  WHERE generation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_usage_charge_dedup_user_processed
  ON miniapp.llm_usage_charge_dedup(user_id, processed_at DESC);

ALTER TABLE miniapp.llm_usage_charge_dedup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.llm_usage_charge_dedup FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.llm_usage_charge_dedup TO service_role, postgres;

-- Preserve idempotency before pruning existing detail rows.
INSERT INTO miniapp.llm_usage_charge_dedup(
  charge_key, generation_id, user_id, charged_amount, status, processed_at
)
SELECT
  charge_key, generation_id, user_id, charged_amount, status, created_at
FROM miniapp.llm_usage_charges
ON CONFLICT (charge_key) DO UPDATE
SET generation_id = COALESCE(
      miniapp.llm_usage_charge_dedup.generation_id,
      EXCLUDED.generation_id
    ),
    charged_amount = EXCLUDED.charged_amount,
    status = EXCLUDED.status;

CREATE OR REPLACE FUNCTION miniapp.prepare_llm_usage_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- Only free-model failures are represented as failed spending details.
  -- Paid failures continue to produce no charge row.
  IF NEW.model_markup = 0
     AND COALESCE(NEW.metadata ->> 'chat_status', 'success') <> 'success' THEN
    NEW.status := 'failed';
    NEW.initial_amount := 0;
    NEW.calculated_amount := 0;
    NEW.charged_amount := 0;
    NEW.fallback_used := false;
    NEW.metadata := COALESCE(NEW.metadata, '{}'::JSONB) || jsonb_build_object(
      'billing_mode', 'failed_free',
      'difference_reason', 'generation_failed'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM miniapp.llm_usage_charge_dedup AS dedup
    WHERE dedup.charge_key = NEW.charge_key
       OR (
         NEW.generation_id IS NOT NULL
         AND dedup.generation_id = NEW.generation_id
       )
  ) THEN
    RAISE EXCEPTION 'LLM usage charge already processed and pruned'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.retain_recent_llm_usage_charges()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO miniapp.llm_usage_charge_dedup(
    charge_key, generation_id, user_id, charged_amount, status, processed_at
  ) VALUES (
    NEW.charge_key,
    NEW.generation_id,
    NEW.user_id,
    NEW.charged_amount,
    NEW.status,
    NEW.created_at
  )
  ON CONFLICT (charge_key) DO UPDATE
  SET generation_id = COALESCE(
        miniapp.llm_usage_charge_dedup.generation_id,
        EXCLUDED.generation_id
      ),
      charged_amount = EXCLUDED.charged_amount,
      status = EXCLUDED.status;

  -- Pending rows are temporarily retained even when older than the latest
  -- 100 so they can settle. Their reconciliation update invokes this trigger
  -- again and makes them eligible for pruning.
  DELETE FROM miniapp.llm_usage_charges AS charge
  WHERE charge.user_id = NEW.user_id
    AND charge.status <> 'pending'
    AND charge.id IN (
      SELECT ranked.id
      FROM miniapp.llm_usage_charges AS ranked
      WHERE ranked.user_id = NEW.user_id
      ORDER BY ranked.created_at DESC, ranked.id DESC
      OFFSET 100
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prepare_llm_usage_charge
  ON miniapp.llm_usage_charges;
CREATE TRIGGER trg_prepare_llm_usage_charge
BEFORE INSERT ON miniapp.llm_usage_charges
FOR EACH ROW
EXECUTE FUNCTION miniapp.prepare_llm_usage_charge();

DROP TRIGGER IF EXISTS trg_retain_recent_llm_usage_charges
  ON miniapp.llm_usage_charges;
CREATE TRIGGER trg_retain_recent_llm_usage_charges
AFTER INSERT OR UPDATE OF status, charged_amount
ON miniapp.llm_usage_charges
FOR EACH ROW
EXECUTE FUNCTION miniapp.retain_recent_llm_usage_charges();

-- Apply the 100-row cap to existing users. Pending rows remain until settled.
WITH ranked AS (
  SELECT
    id,
    status,
    row_number() OVER (
      PARTITION BY user_id
      ORDER BY created_at DESC, id DESC
    ) AS position
  FROM miniapp.llm_usage_charges
)
DELETE FROM miniapp.llm_usage_charges AS charge
USING ranked
WHERE charge.id = ranked.id
  AND ranked.position > 100
  AND ranked.status <> 'pending';

COMMENT ON TABLE miniapp.llm_usage_charge_dedup IS
  'Minimal permanent idempotency keys for LLM charges whose full details are capped at 100 rows per user.';
COMMENT ON FUNCTION miniapp.prepare_llm_usage_charge() IS
  'Marks failed free generations at 0.0 and rejects retries whose full detail row was pruned.';
COMMENT ON FUNCTION miniapp.retain_recent_llm_usage_charges() IS
  'Retains the latest 100 full LLM spending rows per user while preserving pending settlements.';

NOTIFY pgrst, 'reload schema';

COMMIT;
