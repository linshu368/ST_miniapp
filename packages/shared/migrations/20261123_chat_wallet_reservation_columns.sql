-- domain: billing
-- Additive prerequisites only. No reservations are active until the separate RPC migration.
-- psql file: CONCURRENTLY must stay outside a transaction. If its build fails,
-- inspect/drop only the invalid index concurrently, then resume this unchanged file.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE billing.usage_charges
  ADD COLUMN IF NOT EXISTS reserved_main_credits numeric(14,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_bonus_credits numeric(14,1) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='billing.usage_charges'::regclass AND conname='usage_charges_reservation_nonnegative') THEN
    ALTER TABLE billing.usage_charges ADD CONSTRAINT usage_charges_reservation_nonnegative
      CHECK (reserved_main_credits >= 0 AND reserved_bonus_credits >= 0) NOT VALID;
  END IF;
END $$;
COMMIT;
SET lock_timeout = '5s';
SET statement_timeout = '120s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_charges_reserved_user_idx ON billing.usage_charges(user_id)
  WHERE reserved_main_credits > 0 OR reserved_bonus_credits > 0;

ALTER TABLE billing.usage_charges VALIDATE CONSTRAINT usage_charges_reservation_nonnegative;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='billing.usage_charges_reserved_user_idx'::regclass AND indisvalid AND indisready) THEN
    RAISE EXCEPTION 'Reservation index is not valid';
  END IF;
END $$;
