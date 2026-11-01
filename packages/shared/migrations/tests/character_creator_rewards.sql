-- Synthetic local fixtures only. Executed by the reusable first-token/billing suite.
CREATE SCHEMA creator_reward_test;
CREATE FUNCTION creator_reward_test.assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'creator reward: %',label; END IF; END $$;
CREATE FUNCTION creator_reward_test.charge(k uuid, payer uuid, creator uuid, amount numeric,
  finish text DEFAULT 'stop', provider text DEFAULT 'openrouter') RETURNS jsonb LANGUAGE sql AS $$
  SELECT billing.charge_llm_usage(k,'creator-'||k,payer,'fixture-model','fixture/model',
    'Fixture',1,1,0.001,1,CASE WHEN amount=0 THEN 0 ELSE 1 END,amount,false,
    jsonb_build_object('billing_mode','fixed_tier','chat_status','success','finish_reason',finish,
      'provider',provider,'fixed_deduction',amount,'payable_credits',amount,
      'wallet_policy','main_then_bonus','model_tier','light',
      'creator_reward',jsonb_build_object('character_id','90000000-0000-4000-8000-000000000010',
        'creator_user_id',creator,'rate',0.4,'wallet','bonus','policy_version',1)));
$$;

INSERT INTO app_core.users(id) VALUES
  ('90000000-0000-4000-8000-000000000001'),
  ('90000000-0000-4000-8000-000000000002'),
  ('90000000-0000-4000-8000-000000000003');
INSERT INTO app_core.characters(id) VALUES('90000000-0000-4000-8000-000000000010');
INSERT INTO app_core.character_creations(character_id,owner_user_id)
  VALUES('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002');
INSERT INTO billing.user_wallets(user_id,main_credits,bonus_credits) VALUES
  ('90000000-0000-4000-8000-000000000001',1000,100),
  ('90000000-0000-4000-8000-000000000002',1000,0),
  ('90000000-0000-4000-8000-000000000003',1000,0);

DO $$ DECLARE
  payer uuid:='90000000-0000-4000-8000-000000000001';
  creator uuid:='90000000-0000-4000-8000-000000000002';
  other uuid:='90000000-0000-4000-8000-000000000003';
  k uuid; result jsonb;
BEGIN
  k:='90000000-0000-4000-8000-000000000101';
  result:=creator_reward_test.charge(k,payer,creator,20);
  PERFORM creator_reward_test.assert((result#>>'{charge,charged_amount}')::numeric=20,'actual debit');
  PERFORM creator_reward_test.assert((SELECT bonus_credits=8 FROM billing.user_wallets WHERE user_id=creator),'40 percent actual reward');
  PERFORM creator_reward_test.charge(k,payer,creator,200);
  PERFORM creator_reward_test.assert((SELECT count(*)=1 FROM billing.character_creator_rewards WHERE charge_key=k),'duplicate journal');
  PERFORM creator_reward_test.assert((SELECT count(*)=1 AND sum(amount)=8 FROM billing.wallet_ledger WHERE entry_type='creator_reward' AND reference_id=k::text),'duplicate grant');

  -- Free, unfinished, failed and self rounds never create a reward.
  PERFORM creator_reward_test.charge('90000000-0000-4000-8000-000000000102',payer,creator,0);
  PERFORM creator_reward_test.charge('90000000-0000-4000-8000-000000000103',payer,creator,50,'length');
  PERFORM creator_reward_test.charge('90000000-0000-4000-8000-000000000104',creator,creator,8);
  PERFORM creator_reward_test.assert((SELECT count(*)=1 FROM billing.character_creator_rewards),'zero/failure/self reward');

  -- A pending replay cannot change the accepted price or creator snapshot.
  k:='90000000-0000-4000-8000-000000000105';
  result:=creator_reward_test.charge(k,payer,creator,30,NULL);
  PERFORM creator_reward_test.assert(result#>>'{charge,status}'='pending','pending gate');
  PERFORM creator_reward_test.assert(NOT EXISTS(SELECT 1 FROM billing.character_creator_rewards WHERE charge_key=k),'reward before debit');
  PERFORM creator_reward_test.charge(k,payer,other,90,'stop','venice');
  PERFORM creator_reward_test.assert((SELECT charged_amount=30 AND creator_user_id=creator AND reward_amount=12 FROM billing.character_creator_rewards WHERE charge_key=k),'frozen owner/rate/price replay');

  -- Mixed/main/bonus wallet payment all use the actual debited total.
  UPDATE billing.user_wallets SET main_credits=0 WHERE user_id=payer;
  k:='90000000-0000-4000-8000-000000000106';
  PERFORM creator_reward_test.charge(k,payer,creator,1,'stop','venice');
  PERFORM creator_reward_test.assert((SELECT reward_amount=0.4 FROM billing.character_creator_rewards WHERE charge_key=k),'fractional exact 40 percent');
  PERFORM creator_reward_test.assert((SELECT amount=-1 AND bonus_delta=-1 FROM billing.wallet_ledger WHERE debit_key=k::text),'bonus-funded actual charge');

  -- Spend creator rewards before payer refund; refund always succeeds and only
  -- the unavailable portion becomes debt, then later rewards offset that debt.
  UPDATE billing.user_wallets SET bonus_credits=2 WHERE user_id=creator;
  k:='90000000-0000-4000-8000-000000000101';
  result:=billing.refund_llm_usage_charge(k,'local regression');
  PERFORM creator_reward_test.assert(result->>'status'='refunded','payer refund blocked');
  PERFORM creator_reward_test.assert((SELECT outstanding_debt=6 FROM billing.character_creator_reward_balances WHERE creator_user_id=creator),'missing recovery debt');
  PERFORM creator_reward_test.assert((SELECT bonus_credits=0 FROM billing.user_wallets WHERE user_id=creator),'negative creator wallet');
  PERFORM billing.refund_llm_usage_charge(k,'duplicate');
  PERFORM creator_reward_test.charge(k,payer,creator,20);
  PERFORM creator_reward_test.assert((SELECT outstanding_debt=6 FROM billing.character_creator_reward_balances WHERE creator_user_id=creator),'repeated refund/replay changed debt');
  PERFORM creator_reward_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE entry_type='creator_reward_reversal' AND reference_id=k::text),'duplicate reversal');

  k:='90000000-0000-4000-8000-000000000107';
  PERFORM creator_reward_test.charge(k,payer,creator,10);
  PERFORM creator_reward_test.assert((SELECT debt_offset_amount=4 AND credited_amount=0 FROM billing.character_creator_rewards WHERE charge_key=k),'full offset');
  k:='90000000-0000-4000-8000-000000000108';
  PERFORM creator_reward_test.charge(k,payer,creator,10);
  PERFORM creator_reward_test.assert((SELECT debt_offset_amount=2 AND credited_amount=2 FROM billing.character_creator_rewards WHERE charge_key=k),'partial offset');
  PERFORM creator_reward_test.assert((SELECT outstanding_debt=0 FROM billing.character_creator_reward_balances WHERE creator_user_id=creator),'debt not cleared');
  PERFORM billing.refund_llm_usage_charge('90000000-0000-4000-8000-000000000107','offset award refunded');
  PERFORM creator_reward_test.assert((SELECT outstanding_debt=2 FROM billing.character_creator_reward_balances WHERE creator_user_id=creator),'offset reward reversal must recover gross reward');

  -- A debit failure rolls back BOTH debit and reward, without creating a debt fact.
  UPDATE billing.user_wallets SET main_credits=0,bonus_credits=0 WHERE user_id=payer;
  BEGIN
    PERFORM creator_reward_test.charge('90000000-0000-4000-8000-000000000109',payer,creator,50);
    RAISE EXCEPTION 'insufficient debit was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM='insufficient debit was accepted' THEN RAISE; END IF;
  END;
  PERFORM creator_reward_test.assert(NOT EXISTS(SELECT 1 FROM billing.character_creator_rewards WHERE charge_key='90000000-0000-4000-8000-000000000109'),'reward after failed debit');
  UPDATE billing.user_wallets SET main_credits=1000 WHERE user_id=payer;

  -- Simulate legitimate detail retention; durable dedup must return without a new reward.
  k:='90000000-0000-4000-8000-000000000105';
  DELETE FROM billing.llm_usage_charges WHERE charge_key=k;
  result:=creator_reward_test.charge(k,payer,other,300);
  PERFORM creator_reward_test.assert(result->>'charge_status'='already_archived','archive result');
  PERFORM creator_reward_test.assert((SELECT count(*)=1 AND sum(reward_amount)=12 FROM billing.character_creator_rewards WHERE charge_key=k),'archive reward duplicate');
END $$;

DO $$ BEGIN
  PERFORM creator_reward_test.assert(NOT has_table_privilege('service_role','billing.character_creator_rewards','INSERT'),'journal direct insert privilege');
  PERFORM creator_reward_test.assert(NOT has_table_privilege('authenticated','billing.character_creator_reward_balances','SELECT'),'debt data exposed');
  PERFORM creator_reward_test.assert(NOT has_function_privilege('service_role','billing.grant_character_creator_reward(billing.llm_usage_charges)','EXECUTE'),'grant helper is a public write API');
  PERFORM creator_reward_test.assert(NOT has_function_privilege('authenticated','billing.reverse_character_creator_reward(uuid)','EXECUTE'),'reversal helper exposed');
END $$;
