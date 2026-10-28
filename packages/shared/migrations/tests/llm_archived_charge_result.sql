-- Synthetic local-only regression with real 100-row retention triggers and wallet debit.
-- Never execute this fixture in TEST or production. Everything rolls back, including test DDL.
BEGIN;
CREATE SCHEMA archived_charge_test;
CREATE TEMP TABLE archived_charge_gate_definition AS
  SELECT pg_get_functiondef('billing.chat_delivery_billing_gate(uuid)'::regprocedure) AS definition;

DO $$
DECLARE
  u uuid := '00000000-0000-4000-8000-0000000005a0';
  pending_key uuid := '00000000-0000-4000-8000-000000005fff';
  k uuid; r jsonb; i integer;
BEGIN
  INSERT INTO app_core.users(id) VALUES(u);
  INSERT INTO billing.user_wallets(user_id,main_credits,bonus_credits) VALUES(u,1000,0);
  PERFORM vip_t4_test.charge(u,pending_key,'archived-pending',2,'main_only','premium',NULL);
  UPDATE billing.llm_usage_charges SET created_at='2009-01-01' WHERE charge_key=pending_key;
  FOR i IN 1..102 LOOP
    k:=('00000000-0000-4000-8000-'||lpad((5000+i)::text,12,'0'))::uuid;
    r:=vip_t4_test.charge(u,k,'archived-gen-'||i,1,'main_only','premium',CASE WHEN i=2 THEN 'timeout' ELSE 'stop' END);
    UPDATE billing.llm_usage_charges SET created_at='2010-01-01'::timestamptz+make_interval(secs=>i)
      WHERE charge_key=k;
  END LOOP;
  PERFORM vip_t4_test.assert(NOT EXISTS(SELECT 1 FROM billing.llm_usage_charges
    WHERE charge_key IN ('00000000-0000-4000-8000-000000005001','00000000-0000-4000-8000-000000005002')),
    'fixture did not prune first charged and timeout details');
  PERFORM vip_t4_test.assert((SELECT count(*)=2 FROM billing.llm_usage_charge_dedup
    WHERE charge_key IN ('00000000-0000-4000-8000-000000005001','00000000-0000-4000-8000-000000005002')),
    'retention lost permanent facts');
  PERFORM vip_t4_test.assert((SELECT status='pending' FROM billing.llm_usage_charges WHERE charge_key=pending_key),
    'retention pruned an unfinished charge');
END $$;

-- Replaying terminal rows must not even enter the delivery gate or lock its request.
CREATE OR REPLACE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'archived test: delivery gate called'; END $$;
DO $$
DECLARE u uuid := '00000000-0000-4000-8000-0000000005a0'; r jsonb;
BEGIN
  r:=vip_t4_test.charge(u,'00000000-0000-4000-8000-000000005001','archived-gen-1',999,'main_only','premium','stop');
  PERFORM vip_t4_test.assert(r->>'charge_status'='already_archived'
    AND r#>>'{archived_charge,status}'='charged'
    AND (r#>>'{archived_charge,charged_amount}')::numeric=1
    AND NOT (r ? 'charge') AND NOT (r ? 'wallet'), 'charged archive was fabricated/repriced');
  r:=vip_t4_test.charge(u,'00000000-0000-4000-8000-000000005002','archived-gen-2',999,'main_only','premium','stop');
  PERFORM vip_t4_test.assert(r#>>'{archived_charge,status}'='failed'
    AND (r#>>'{archived_charge,charged_amount}')::numeric=0,'timeout archive reopened');
  r:=vip_t4_test.charge(u,'00000000-0000-4000-8000-000000005aaa','archived-gen-1',999,'main_only','premium','stop');
  PERFORM vip_t4_test.assert(r#>>'{archived_charge,charge_key}'='00000000-0000-4000-8000-000000005001',
    'generation ID replay lost the original archived identity');
  r:=vip_t4_test.charge(u,'00000000-0000-4000-8000-000000005102','archived-gen-102',999,'main_only','premium','stop');
  PERFORM vip_t4_test.assert(r->>'charge_status'='already_charged'
    AND (r#>>'{charge,charged_amount}')::numeric=1,'terminal detail entered gate/repriced');
  BEGIN
    PERFORM vip_t4_test.charge(u,'00000000-0000-4000-8000-000000005fff','archived-pending',999,'main_only','premium','stop');
    RAISE EXCEPTION 'pending charge skipped delivery gate';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    PERFORM vip_t4_test.assert(SQLERRM='archived test: delivery gate called','pending charge failed for wrong reason');
  END;
  BEGIN
    PERFORM vip_t4_test.charge('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-000000005001','archived-gen-1',1,'main_only','premium','stop');
    RAISE EXCEPTION 'wrong owner accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  PERFORM vip_t4_test.assert((SELECT main_credits=899 FROM billing.user_wallets WHERE user_id=u),'terminal replay changed wallet');
  PERFORM vip_t4_test.assert((SELECT count(*)=101 FROM billing.wallet_ledger WHERE user_id=u),'terminal replay duplicated debit');
END $$;
DO $$ DECLARE d text; BEGIN SELECT definition INTO d FROM archived_charge_gate_definition; EXECUTE d; END $$;

-- Missing history marker can still recover a genuinely pending frozen quote.
DO $$ DECLARE r jsonb; BEGIN
  r:=vip_t4_test.charge('00000000-0000-4000-8000-0000000005a0','00000000-0000-4000-8000-000000005fff','archived-pending',999,'main_only','premium','stop');
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=2,'pending frozen price failed to recover');
  r:=vip_t4_test.charge('00000000-0000-4000-8000-0000000005a0','00000000-0000-4000-8000-000000005fff','archived-pending',999,'main_only','premium','stop');
  PERFORM vip_t4_test.assert(r->>'charge_status'='already_archived'
    AND (r#>>'{archived_charge,charged_amount}')::numeric=2,'pending settlement/pruning replay charged twice');
END $$;

-- A different constraint failure must be surfaced, with the tentative wallet debit rolled back.
CREATE FUNCTION archived_charge_test.reject_unknown_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation_id='archived-unknown-conflict' THEN
    RAISE EXCEPTION 'archived test: unrelated uniqueness failure' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER archived_charge_test_unknown BEFORE INSERT ON billing.llm_usage_charges
FOR EACH ROW EXECUTE FUNCTION archived_charge_test.reject_unknown_conflict();
DO $$ DECLARE r jsonb; BEGIN
  BEGIN
    PERFORM vip_t4_test.charge('00000000-0000-4000-8000-0000000005a0','00000000-0000-4000-8000-000000005ccc','archived-unknown-conflict',1,'main_only','premium','stop');
    RAISE EXCEPTION 'unknown conflict swallowed';
  EXCEPTION WHEN unique_violation THEN
    PERFORM vip_t4_test.assert(SQLERRM='archived test: unrelated uniqueness failure','wrong uniqueness error');
  END;
  PERFORM vip_t4_test.assert((SELECT main_credits=897 FROM billing.user_wallets WHERE user_id='00000000-0000-4000-8000-0000000005a0'),'unknown conflict changed wallet');
  PERFORM vip_t4_test.assert(NOT EXISTS(SELECT 1 FROM billing.wallet_ledger WHERE debit_key='00000000-0000-4000-8000-000000005ccc'),'unknown conflict kept tentative debit');
  INSERT INTO billing.llm_usage_charge_dedup(charge_key,generation_id,user_id,status,charged_amount)
  VALUES('00000000-0000-4000-8000-000000005ddd','archived-orphan-pending','00000000-0000-4000-8000-0000000005a0','pending',0);
  BEGIN
    PERFORM vip_t4_test.charge('00000000-0000-4000-8000-0000000005a0','00000000-0000-4000-8000-000000005ddd','archived-orphan-pending',1,'main_only','premium','stop');
    RAISE EXCEPTION 'pending dedup without detail accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END $$;
ROLLBACK;
