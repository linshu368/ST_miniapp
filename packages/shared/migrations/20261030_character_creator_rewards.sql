-- domain: billing (creator reward facts, bonus wallet credit and refund recovery).
-- Prerequisite: character creator core migration; latest charge/delivery/dedup RPCs.
-- Same transaction as the actual LLM debit. No quote/prepayment rewards or backfill.
-- Short-lived llm_usage_charges details are NOT referenced by FK; charge_key survives.
-- Release: core schema -> this migration -> backend/frontend. TEST/local first.
-- Recovery: stop new creator entries; retain grants/debts/ledger, forward-fix only.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$ BEGIN
  IF to_regclass('app_core.character_creations') IS NULL THEN
    RAISE EXCEPTION 'character creator core migration is required';
  END IF;
END $$;

-- Widen the existing allow-list without copying (and accidentally dropping)
-- other teams' ledger kinds. The old validated check proves historical rows
-- satisfy this weaker check; NOT VALID avoids a full financial-ledger scan.
DO $$ DECLARE old_rule text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO old_rule FROM pg_constraint
    WHERE conrelid='billing.wallet_ledger'::regclass
      AND conname='wallet_ledger_entry_type_check';
  IF old_rule IS NULL THEN RAISE EXCEPTION 'Expected ledger entry type check is missing'; END IF;
  IF position('creator_reward' IN old_rule)=0 THEN
    ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
    EXECUTE format('ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK ((%s) OR entry_type IN (''creator_reward'',''creator_reward_reversal'')) NOT VALID',old_rule);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS billing.character_creator_reward_balances (
  creator_user_id uuid PRIMARY KEY REFERENCES app_core.users(id),
  outstanding_debt numeric(14,1) NOT NULL DEFAULT 0 CHECK (outstanding_debt >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing.character_creator_rewards (
  charge_key uuid PRIMARY KEY,
  character_id uuid NOT NULL,
  creator_user_id uuid NOT NULL REFERENCES app_core.users(id),
  payer_user_id uuid NOT NULL REFERENCES app_core.users(id),
  charged_amount numeric(14,1) NOT NULL CHECK (charged_amount > 0),
  reward_rate numeric NOT NULL CHECK (reward_rate = 0.4),
  reward_amount numeric(14,1) NOT NULL CHECK (reward_amount > 0),
  debt_offset_amount numeric(14,1) NOT NULL DEFAULT 0 CHECK (debt_offset_amount >= 0),
  credited_amount numeric(14,1) NOT NULL CHECK (credited_amount >= 0),
  grant_ledger_id uuid,
  reversal_recovered_amount numeric(14,1) NOT NULL DEFAULT 0 CHECK (reversal_recovered_amount >= 0),
  reversal_debt_amount numeric(14,1) NOT NULL DEFAULT 0 CHECK (reversal_debt_amount >= 0),
  reversal_ledger_id uuid,
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (creator_user_id <> payer_user_id),
  CHECK (reward_amount = round(charged_amount * reward_rate, 1)),
  CHECK (credited_amount + debt_offset_amount = reward_amount),
  CHECK ((reversed_at IS NULL AND reversal_recovered_amount = 0 AND reversal_debt_amount = 0)
    OR (reversed_at IS NOT NULL AND reversal_recovered_amount + reversal_debt_amount = reward_amount))
);
CREATE INDEX IF NOT EXISTS character_creator_rewards_creator_created_idx
  ON billing.character_creator_rewards(creator_user_id, created_at DESC);
ALTER TABLE billing.character_creator_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.character_creator_reward_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.character_creator_rewards, billing.character_creator_reward_balances
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON billing.character_creator_rewards, billing.character_creator_reward_balances TO service_role;
GRANT ALL ON billing.character_creator_rewards, billing.character_creator_reward_balances TO postgres;

-- The accepted owner/rule travels with the quote. Never re-evaluate visibility or
-- current pricing when pending charges are replayed or a card becomes private.
CREATE OR REPLACE FUNCTION billing.lock_character_creator_wallets(p_payer uuid, p_reward jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_creator uuid; v_character uuid;
BEGIN
  IF p_reward IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_reward) <> 'object'
     OR p_reward->>'wallet' IS DISTINCT FROM 'bonus'
     OR p_reward->>'policy_version' IS DISTINCT FROM '1'
     OR (p_reward->>'rate')::numeric IS DISTINCT FROM 0.4 THEN
    RAISE EXCEPTION 'Invalid frozen creator reward policy' USING ERRCODE='22023';
  END IF;
  v_creator := (p_reward->>'creator_user_id')::uuid;
  v_character := (p_reward->>'character_id')::uuid;
  IF p_payer IS NULL OR v_creator IS NULL OR v_character IS NULL THEN
    RAISE EXCEPTION 'Incomplete frozen creator reward identity' USING ERRCODE='22023';
  END IF;
  IF v_creator = p_payer THEN RETURN; END IF;
  -- Prelock BOTH wallets before apply_wallet_debit. A uses B's card while B uses
  -- A's card must never acquire their two wallet locks in opposite orders.
  INSERT INTO billing.user_wallets(user_id)
    SELECT u FROM unnest(ARRAY[p_payer, v_creator]) AS ids(u) ORDER BY u
    ON CONFLICT(user_id) DO NOTHING;
  PERFORM w.user_id FROM billing.user_wallets w
    WHERE w.user_id IN (p_payer, v_creator) ORDER BY w.user_id FOR UPDATE;
END $$;

CREATE OR REPLACE FUNCTION billing.grant_character_creator_reward(p_charge billing.llm_usage_charges)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_rule jsonb; v_creator uuid; v_reward numeric(14,1); v_offset numeric(14,1);
  v_credit numeric(14,1); v_debt numeric(14,1); v_ledger uuid;
BEGIN
  v_rule := p_charge.metadata->'creator_reward';
  IF v_rule IS NULL OR p_charge.charged_amount <= 0
    OR p_charge.status IN ('pending','free','failed')
    OR p_charge.metadata->>'business_status' = 'refunded' THEN RETURN; END IF;
  v_creator := (v_rule->>'creator_user_id')::uuid;
  IF v_creator = p_charge.user_id THEN RETURN; END IF;
  -- Called only by the final charge branch; an archived or duplicate charge
  -- returns earlier and cannot recreate grants after detail retention.
  IF EXISTS(SELECT 1 FROM billing.character_creator_rewards WHERE charge_key=p_charge.charge_key) THEN RETURN; END IF;
  v_reward := round(p_charge.charged_amount * (v_rule->>'rate')::numeric, 1);
  IF v_reward <= 0 THEN RETURN; END IF;
  INSERT INTO billing.character_creator_reward_balances(creator_user_id)
    VALUES(v_creator) ON CONFLICT(creator_user_id) DO NOTHING;
  SELECT outstanding_debt INTO v_debt FROM billing.character_creator_reward_balances
    WHERE creator_user_id=v_creator FOR UPDATE;
  v_offset := least(v_debt, v_reward);
  v_credit := v_reward-v_offset;
  UPDATE billing.character_creator_reward_balances
    SET outstanding_debt=outstanding_debt-v_offset, updated_at=now()
    WHERE creator_user_id=v_creator;
  IF v_credit > 0 THEN
    SELECT o_ledger_id INTO v_ledger FROM billing.grant_bonus_credits(
      v_creator, v_credit, 'creator_reward', 'llm_creator_reward', p_charge.charge_key::text,
      jsonb_build_object('charge_key',p_charge.charge_key,'character_id',v_rule->>'character_id',
        'charged_amount',p_charge.charged_amount,'reward_amount',v_reward,
        'debt_offset_amount',v_offset,'policy_version',1));
  END IF;
  INSERT INTO billing.character_creator_rewards(charge_key, character_id, creator_user_id,
    payer_user_id, charged_amount, reward_rate, reward_amount, debt_offset_amount,
    credited_amount, grant_ledger_id)
  VALUES(p_charge.charge_key,(v_rule->>'character_id')::uuid,v_creator,p_charge.user_id,
    p_charge.charged_amount,0.4,v_reward,v_offset,v_credit,v_ledger);
END $$;

CREATE OR REPLACE FUNCTION billing.reverse_character_creator_reward(p_charge_key uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r billing.character_creator_rewards; w billing.user_wallets;
  v_recovered numeric(14,1); v_debt numeric(14,1); v_ledger uuid;
BEGIN
  SELECT * INTO r FROM billing.character_creator_rewards WHERE charge_key=p_charge_key FOR UPDATE;
  IF NOT FOUND OR r.reversed_at IS NOT NULL THEN RETURN; END IF;
  SELECT * INTO w FROM billing.user_wallets WHERE user_id=r.creator_user_id FOR UPDATE;
  -- Never block the payer's refund because the creator already spent a reward.
  -- Reversing a reward that had offset older debt reinstates the same gross debt.
  v_recovered := least(w.bonus_credits, r.reward_amount);
  v_debt := r.reward_amount-v_recovered;
  IF v_recovered > 0 THEN
    UPDATE billing.user_wallets SET bonus_credits=bonus_credits-v_recovered, updated_at=now()
      WHERE user_id=r.creator_user_id RETURNING * INTO w;
    INSERT INTO billing.wallet_ledger(user_id,entry_type,amount,main_delta,bonus_delta,
      balance_main,balance_bonus,reference_type,reference_id,metadata)
    VALUES(r.creator_user_id,'creator_reward_reversal',-v_recovered,0,-v_recovered,
      w.main_credits,w.bonus_credits,'llm_creator_reward',p_charge_key::text,
      jsonb_build_object('charge_key',p_charge_key,'reward_amount',r.reward_amount,
        'outstanding_debt',v_debt)) RETURNING id INTO v_ledger;
  END IF;
  INSERT INTO billing.character_creator_reward_balances(creator_user_id,outstanding_debt)
    VALUES(r.creator_user_id,v_debt)
    ON CONFLICT(creator_user_id) DO UPDATE SET
      outstanding_debt=billing.character_creator_reward_balances.outstanding_debt+EXCLUDED.outstanding_debt,
      updated_at=now();
  UPDATE billing.character_creator_rewards SET reversed_at=now(),
    reversal_recovered_amount=v_recovered,reversal_debt_amount=v_debt,reversal_ledger_id=v_ledger
    WHERE charge_key=p_charge_key;
END $$;

-- Keep the existing delivery/stop/archived-result gates byte-for-byte. Guarded
-- local insertions fail closed if an upstream billing function shape has changed.
DO $$ DECLARE d text; old text; new text;
BEGIN
  SELECT pg_get_functiondef('billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure) INTO d;
  IF position('grant_character_creator_reward' IN d)=0 THEN
    IF position('already_archived' IN d)=0 OR position('user_stopped' IN d)=0 THEN
      RAISE EXCEPTION 'Latest archived/user-stop billing migrations are required';
    END IF;
    old := E'        - ''requires_vip'' - ''fixed_deduction_category''';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected frozen quote metadata'; END IF;
    d := replace(d,old,old||E'\n        - ''creator_reward''');
    old := E'  IF v_has_existing THEN\n    IF v_amount > 0 THEN';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected final debit branch'; END IF;
    new := $patch$  IF v_amount > 0 THEN
    PERFORM billing.lock_character_creator_wallets(p_user_id, v_stored->'creator_reward');
  END IF;

$patch$||old;
    d := replace(d,old,new);
    old := E'  RETURN jsonb_build_object(\n    ''charge_status'', v_charge.status,';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected final charge result'; END IF;
    d := replace(d,old,E'  PERFORM billing.grant_character_creator_reward(v_charge);\n\n'||old);
    EXECUTE d;
  END IF;

  SELECT pg_get_functiondef('billing.refund_llm_usage_charge(uuid,text)'::regprocedure) INTO d;
  IF position('reverse_character_creator_reward' IN d)=0 THEN
    old := '  v_refund := billing.refund_wallet_debit(';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected refund debit branch'; END IF;
    d := replace(d,old,E'  PERFORM billing.lock_character_creator_wallets(v_charge.user_id, v_charge.metadata->''creator_reward'');\n'||old);
    old := E'  v_status := v_refund ->> ''status'';';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected refund result'; END IF;
    d := replace(d,old,old||E'\n  PERFORM billing.reverse_character_creator_reward(p_charge_key);');
    EXECUTE d;
  END IF;
END $$;

REVOKE ALL ON FUNCTION billing.lock_character_creator_wallets(uuid,jsonb),
  billing.grant_character_creator_reward(billing.llm_usage_charges),
  billing.reverse_character_creator_reward(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION billing.lock_character_creator_wallets(uuid,jsonb),
  billing.grant_character_creator_reward(billing.llm_usage_charges),
  billing.reverse_character_creator_reward(uuid) TO postgres;
COMMENT ON TABLE billing.character_creator_rewards IS
  'Immutable per-charge 40% creator reward with refund recovery facts; no FK to retained LLM usage details.';
COMMENT ON TABLE billing.character_creator_reward_balances IS
  'Recoverable bonus reward debt projection; offset only against future creator rewards, never blocks payer refunds.';
NOTIFY pgrst,'reload schema';
COMMIT;
