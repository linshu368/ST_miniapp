-- domain: admin
-- Forward-fix the legacy payment-plan draft trigger for the additive payment-channel config.
-- The prior migration updated the managed-config validator, but this older trigger still passed
-- the whole object to jsonb_array_elements(). Keep legacy arrays valid during rollout.
--
-- Lock/capacity: replace one trigger function; no table rewrite, backfill, or business-row scan.
-- Recovery: the transaction/self-check rolls back on failure; after commit use another reviewed
-- forward migration rather than editing an applied migration.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.validate_payment_plan_ids(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_payment_plans_draft_trigger()') IS NULL THEN
    RAISE EXCEPTION 'payment plan draft trigger preflight: expected legacy validator is missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION admin.validate_payment_plans_draft_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF NEW.config_key = 'miniapp_payment_plans' THEN
    IF jsonb_typeof(NEW.value) = 'object' THEN
      PERFORM admin.validate_payment_plan_ids(NEW.value -> 'plans');
    ELSE
      PERFORM admin.validate_payment_plan_ids(NEW.value);
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION admin.validate_payment_plans_draft_trigger()
  FROM PUBLIC, anon, authenticated, service_role;

DO $selfcheck$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('admin.validate_payment_plans_draft_trigger()'::regprocedure)
    INTO STRICT v_definition;
  IF position('NEW.value -> ''plans''' IN v_definition) = 0
     OR position('NEW.value);' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'self-check failed: draft trigger does not preserve object and array paths';
  END IF;
END
$selfcheck$;

COMMIT;
NOTIFY pgrst, 'reload schema';
