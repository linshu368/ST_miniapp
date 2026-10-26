-- Synthetic local-only real-wallet regression. Never apply this fixture remotely.
CREATE SCHEMA user_stop_test;
CREATE FUNCTION user_stop_test.start(p_key uuid,p_price numeric DEFAULT 29,p_reason text DEFAULT 'user_cancelled')
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  PERFORM visible_billing_test.start(p_key);
  UPDATE experience.chat_history SET status='streaming',assistant_reply=NULL,
    llm_finish_reason=p_reason,llm_billing_snapshot=jsonb_build_object(
      'charge_id',p_key,'billing_mode','fixed_tier','payable_credits',p_price,
      'fixed_deduction',p_price,'original_credits',30,'discount_rate',0.95,
      'wallet_policy','main_only','requires_vip',true,'vip_active',true)
    WHERE id=p_key;
END $$;
CREATE FUNCTION user_stop_test.charge(p_key uuid,p_finish text DEFAULT 'user_cancelled')
RETURNS jsonb LANGUAGE sql AS $$
  -- A caller's newer quote must not reprice an accepted manual stop.
  SELECT vip_t4_test.charge('00000000-0000-4000-8000-0000000000e1',p_key,NULL,999,'main_only','premium',p_finish);
$$;
CREATE FUNCTION user_stop_test.cancel_receipt(p_key uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1',
  '00000000-0000-0000-0000-000000000090',jsonb_build_object(
    'assistant_message_id',p_key,'request_id',p_key,'revision',0,'outcome','not_observed',
    'wait_finished_ms',2000,'request_dispatched_ms',100,'backgrounded',false,
    'measurement_method','visible_dom_after_frame_v2','reason','cancelled'));
$$;

UPDATE billing.user_wallets SET main_credits=1000,bonus_credits=50
 WHERE user_id='00000000-0000-4000-8000-0000000000e1';
DO $$ DECLARE k uuid; r jsonb; before_used integer; BEGIN
  -- No visible text / no provider ID: the original discounted quote is sufficient.
  k:='00000000-0000-4000-8000-0000000001a1';
  PERFORM user_stop_test.start(k);
  PERFORM user_stop_test.cancel_receipt(k);
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=29,'manual pretoken stop did not use original VIP price');
  PERFORM vip_t4_test.assert(r#>>'{charge,metadata,finish_reason}'='user_cancelled'
    AND r#>>'{charge,metadata,billing_trigger}'='user_stop','manual stop audit cause lost');
  PERFORM user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((SELECT count(*) FROM billing.wallet_ledger WHERE debit_key=k::text)=1,'manual stop replay double debit');

  -- Partial body and reasoning-only display are both normal paid manual stops.
  k:='00000000-0000-4000-8000-0000000001a2';
  PERFORM user_stop_test.start(k);
  UPDATE experience.chat_history SET assistant_reply='partial' WHERE id=k;
  PERFORM visible_billing_test.report(k,'observed');
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=29,'partial manual stop was free');
  k:='00000000-0000-4000-8000-0000000001a3';
  PERFORM user_stop_test.start(k);
  PERFORM visible_billing_test.report(k,'observed');
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=29,'reasoning-only manual stop was free');

  -- A receipt can win the network race before the server stop marker exists.
  k:='00000000-0000-4000-8000-0000000001a4';
  PERFORM user_stop_test.start(k,0,NULL);
  PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
  SELECT used_rounds INTO before_used FROM billing.character_free_chat_quotas
    WHERE user_id='00000000-0000-4000-8000-0000000000e1' AND character_id='00000000-0000-4000-8000-0000000000e2';
  PERFORM user_stop_test.cancel_receipt(k);
  PERFORM vip_t4_test.assert((SELECT status='reserved' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'receipt released user-stop entitlement before arbitration');
  UPDATE experience.chat_history SET llm_finish_reason='user_cancelled' WHERE id=k;
  r:=billing.finalize_character_free_chat_round(k,false);
  PERFORM vip_t4_test.assert(r->>'status'='consumed','manual stop bypassed free-quota consumption');
  PERFORM billing.finalize_character_free_chat_round(k,false);
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'free manual stop charged stars');
  PERFORM vip_t4_test.assert((SELECT used_rounds=before_used+1 FROM billing.character_free_chat_quotas
    WHERE user_id='00000000-0000-4000-8000-0000000000e1' AND character_id='00000000-0000-4000-8000-0000000000e2'),'manual stop consumed quota twice');

  -- System cutoffs are free, even if a manual-stop RPC arrives concurrently.
  k:='00000000-0000-4000-8000-0000000001a5';
  PERFORM user_stop_test.start(k);
  PERFORM visible_billing_test.report(k,'timed_out');
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'system timeout raced into manual debit');
  k:='00000000-0000-4000-8000-0000000001a6';
  PERFORM user_stop_test.start(k);
  UPDATE experience.chat_generation_requests SET first_token_timeout=false,server_timeout_stage='fallback' WHERE chat_history_id=k;
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'server stage timeout charged');
  k:='00000000-0000-4000-8000-0000000001a7';
  PERFORM user_stop_test.start(k,0);
  PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
  PERFORM visible_billing_test.report(k,'timed_out');
  PERFORM vip_t4_test.assert((SELECT status='released' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'timeout consumed entitlement');

  -- No frozen admission, upstream/legacy cancellation, and metadata alone cannot charge.
  k:='00000000-0000-4000-8000-0000000001a8';
  PERFORM user_stop_test.start(k);
  UPDATE experience.chat_history SET llm_billing_snapshot=NULL WHERE id=k;
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'unaccepted stop invented a quote');
  k:='00000000-0000-4000-8000-0000000001a9';
  PERFORM user_stop_test.start(k,29,'cancelled');
  PERFORM visible_billing_test.report(k,'observed');
  r:=user_stop_test.charge(k,'cancelled');
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'historical cancellation was repriced');
  UPDATE experience.chat_history SET llm_finish_reason='user_cancelled' WHERE id=k;
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'final zero charge reopened');
  k:='00000000-0000-4000-8000-0000000001aa';
  PERFORM user_stop_test.start(k,29,'error');
  PERFORM visible_billing_test.report(k,'observed');
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'untrusted metadata invented a user stop');

  -- The server policy/canonical state, not a caller-controlled missing field, decides.
  k:='00000000-0000-4000-8000-0000000001ac';
  PERFORM user_stop_test.start(k,29,NULL);
  PERFORM vip_t4_test.assert(NOT experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'first_token_timeout'),'early forged timeout won');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason IS NULL FROM experience.chat_history WHERE id=k),'early timeout became authoritative');
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,NULL);
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason='user_cancelled' FROM experience.chat_history WHERE id=k),'omitting reason bypassed new request policy');
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'first_token_timeout');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason='user_cancelled' FROM experience.chat_history WHERE id=k),'repeat changed the winning reason');
  r:=user_stop_test.charge(k);
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=29,'implicit user stop was free');
  k:='00000000-0000-4000-8000-0000000001ad';
  PERFORM user_stop_test.start(k,29,NULL);
  PERFORM visible_billing_test.report(k,'observed');
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'first_token_timeout');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason='user_cancelled' FROM experience.chat_history WHERE id=k),'observed reply accepted forged timeout');
  k:='00000000-0000-4000-8000-0000000001ae';
  PERFORM user_stop_test.start(k,29,NULL);
  UPDATE experience.chat_generation_requests SET request_received_at=now()-interval '30 seconds' WHERE chat_history_id=k;
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'first_token_timeout');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason='timeout' FROM experience.chat_history WHERE id=k),'true deadline became a paid stop');
  r:=user_stop_test.charge(k,'timeout');
  PERFORM vip_t4_test.assert((r#>>'{charge,charged_amount}')::numeric=0,'verified deadline debited');
  k:='00000000-0000-4000-8000-0000000001b0';
  PERFORM user_stop_test.start(k,29,NULL);
  UPDATE experience.chat_generation_requests SET first_token_timeout=false,server_timeout_stage='primary' WHERE chat_history_id=k;
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'user_stop');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason='timeout' FROM experience.chat_history WHERE id=k),'manual stop overwrote real stage cutoff');
  k:='00000000-0000-4000-8000-0000000001af';
  PERFORM user_stop_test.start(k,29,NULL);
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000091',k,'user_stop');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason IS NULL FROM experience.chat_history WHERE id=k),'wrong session cancelled a reply');
  UPDATE experience.chat_generation_requests SET user_stop_billing_enabled=false WHERE chat_history_id=k;
  PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'user_stop');
  PERFORM vip_t4_test.assert((SELECT llm_finish_reason='cancelled' FROM experience.chat_history WHERE id=k),'legacy policy charged retrospectively');
  PERFORM vip_t4_test.assert(NOT (SELECT user_stop_billing_enabled FROM experience.chat_generation_requests WHERE chat_history_id='00000000-0000-4000-8000-000000000081'),'migration rewrote historical policy');
  PERFORM vip_t4_test.assert(NOT has_function_privilege('anon','experience.cancel_chat_generation(uuid,uuid,text)','EXECUTE')
    AND NOT has_function_privilege('authenticated','experience.cancel_chat_generation(uuid,uuid,text)','EXECUTE'),'cancel RPC expanded public access');
END $$;
SELECT user_stop_test.start('00000000-0000-4000-8000-0000000001ab');
