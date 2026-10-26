-- Local-only real RPC/ledger regression. Never apply this fixture remotely.
CREATE SCHEMA visible_billing_test;
CREATE FUNCTION visible_billing_test.start(p_key uuid, p_age_seconds integer DEFAULT 0) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO experience.chat_history(id,user_id,llm_charge_id,revision,status)
    VALUES(p_key,'00000000-0000-4000-8000-0000000000e1',p_key,0,'streaming');
  PERFORM experience.begin_chat_generation_observation(p_key,jsonb_build_object(
    'request_id',p_key,'primary_attempt_id',gen_random_uuid(),'requested_model_id','visible-billing',
    'provider','openrouter','model','fixture/selected','received_at',clock_timestamp()-make_interval(secs=>p_age_seconds),
    'timeout_ms',4000,'fallback_timeout_ms',2000,'deadline_ms',10000,'timeout_rate_target',0.01,
    'catalog_version',1,'mode','send'));
  -- The server is already complete; this alone must not authorize charging.
  UPDATE experience.chat_history SET status='success',assistant_reply='server has text',llm_finish_reason='stop' WHERE id=p_key;
END $$;
CREATE FUNCTION visible_billing_test.report(p_key uuid,p_outcome text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1',
    '00000000-0000-0000-0000-000000000090',jsonb_build_object(
      'assistant_message_id',p_key,'request_id',p_key,'revision',0,'outcome',p_outcome,
      'first_token_visible_ms',CASE WHEN p_outcome='observed' THEN 7200 END,
      'wait_finished_ms',CASE WHEN p_outcome='observed' THEN 7200 ELSE 10000 END,
      'first_token_received_ms',7000,'request_dispatched_ms',100,'backgrounded',false,
      'measurement_method','visible_dom_after_frame_v2','reason',CASE WHEN p_outcome='observed' THEN NULL ELSE 'not_visible' END));
$$;
CREATE FUNCTION visible_billing_test.charge(p_key uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT vip_t4_test.charge('00000000-0000-4000-8000-0000000000e1',p_key,'visible-'||p_key,30,'main_only','premium','stop');
$$;

INSERT INTO app_core.users(id) VALUES('00000000-0000-4000-8000-0000000000e1');
INSERT INTO app_core.characters(id) VALUES('00000000-0000-4000-8000-0000000000e2');
INSERT INTO billing.user_wallets(user_id,main_credits,bonus_credits)
  VALUES('00000000-0000-4000-8000-0000000000e1',100,50);
DO $$ DECLARE k uuid; r jsonb; BEGIN
  -- The additive migration must not silently change historical charging policy.
  PERFORM vip_t4_test.assert(NOT EXISTS(SELECT 1 FROM experience.chat_generation_requests WHERE requires_visible_token),'historical policy changed');
  k:='00000000-0000-4000-8000-000000000081';
  PERFORM visible_billing_test.start(k);
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert(r#>>'{charge,status}'='pending' AND (r#>>'{charge,charged_amount}')::numeric=0,'server stop without display was debited');
  PERFORM visible_billing_test.report(k,'observed');
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=30,'visible success did not settle original price');
  PERFORM visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert((SELECT count(*) FROM billing.wallet_ledger WHERE debit_key=k::text)=1,'visible replay charged twice');

  k:='00000000-0000-4000-8000-000000000082';
  PERFORM visible_billing_test.start(k);
  PERFORM visible_billing_test.charge(k); -- settle wins the first race, but cannot debit
  PERFORM visible_billing_test.report(k,'timed_out');
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert(r#>>'{charge,status}'='failed' AND r#>>'{charge,metadata,delivery_billing_gate}'='waived','timeout not waived');
  PERFORM visible_billing_test.report(k,'observed'); -- duplicate must not change timeout
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'late report reopened timeout charge');

  k:='00000000-0000-4000-8000-000000000083';
  PERFORM visible_billing_test.start(k,30);
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert(r#>>'{charge,status}'='failed','missing display receipt not waived');
  PERFORM visible_billing_test.report(k,'observed');
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'late receipt reopened waived charge');

  k:='00000000-0000-4000-8000-000000000084';
  PERFORM visible_billing_test.start(k);
  UPDATE experience.chat_generation_requests SET first_token_timeout=true,server_timeout_stage='fallback' WHERE chat_history_id=k;
  r:=visible_billing_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0 AND r#>>'{charge,status}'='failed','server stage timeout charged');

  k:='00000000-0000-4000-8000-000000000085';
  PERFORM visible_billing_test.start(k);
  PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
  r:=billing.finalize_character_free_chat_round(k,true);
  PERFORM vip_t4_test.assert(r->>'status'='reserved' AND (r->>'used_rounds')::integer=0,'server completion consumed unseen free round');
  PERFORM visible_billing_test.report(k,'timed_out');
  PERFORM vip_t4_test.assert((SELECT status='released' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'receipt did not release quota immediately');
  r:=billing.finalize_character_free_chat_round(k,true);
  PERFORM vip_t4_test.assert(r->>'status'='released' AND (r->>'used_rounds')::integer=0,'timeout consumed free round');
  PERFORM billing.finalize_character_free_chat_round(k,true);

  k:='00000000-0000-4000-8000-000000000086';
  PERFORM visible_billing_test.start(k);
  PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
  PERFORM visible_billing_test.report(k,'observed');
  PERFORM billing.finalize_character_free_chat_round(k,true);
  r:=billing.finalize_character_free_chat_round(k,true);
  PERFORM vip_t4_test.assert(r->>'status'='consumed' AND (r->>'used_rounds')::integer=1,'visible free quota must consume once');

  k:='00000000-0000-4000-8000-000000000087';
  PERFORM visible_billing_test.start(k,30);
  PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
  r:=billing.finalize_character_free_chat_round(k,true);
  PERFORM vip_t4_test.assert(r->>'status'='released' AND (r->>'used_rounds')::integer=1,'missing receipt consumed quota');
  PERFORM vip_t4_test.assert((SELECT main_credits=70 AND bonus_credits=50 FROM billing.user_wallets WHERE user_id='00000000-0000-4000-8000-0000000000e1'),'no-token attempts changed wallet');
END $$;
SELECT visible_billing_test.start('00000000-0000-4000-8000-000000000091');
