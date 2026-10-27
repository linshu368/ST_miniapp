-- Local synthetic fixtures only. Never apply this test to a remote database.
CREATE SCHEMA recoverable_test;
CREATE FUNCTION recoverable_test.start(k uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM user_stop_test.start(k,29,NULL);
 UPDATE experience.chat_generation_requests SET recoverable_delivery=true WHERE chat_history_id=k;
 UPDATE experience.chat_history SET session_id='00000000-0000-0000-0000-000000000090',turn_index=1 WHERE id=k;
END $$;
CREATE FUNCTION recoverable_test.report(k uuid, outcome text, reason text, received numeric DEFAULT NULL, hidden boolean DEFAULT false, displayed numeric DEFAULT NULL)
RETURNS boolean LANGUAGE sql AS $$
 SELECT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',jsonb_build_object(
 'assistant_message_id',k,'request_id',k,'revision',0,'outcome',outcome,'reason',reason,
 'first_token_received_ms',received,'first_token_visible_ms',displayed,'backgrounded',hidden,
 'measurement_method','visible_dom_after_frame_v3','wait_finished_ms',COALESCE(displayed,10000)));
$$;
CREATE FUNCTION recoverable_test.complete(k uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM experience.record_chat_delivery_preview(k,0,3000,'reasoning','first public token');
 UPDATE experience.chat_generation_requests r SET delivery_attempt_id=(SELECT a.id FROM experience.chat_generation_attempts a WHERE a.chat_history_id=k AND a.role='primary') WHERE r.chat_history_id=k;
 UPDATE experience.chat_history SET status='success',llm_finish_reason='stop',assistant_reply='recoverable complete reply' WHERE id=k;
END $$;
DO $$ DECLARE k uuid; result jsonb; q integer; BEGIN
 k:='00000000-0000-4000-8000-0000000002a1';
 PERFORM recoverable_test.start(k);
 PERFORM vip_t4_test.assert(NOT experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'first_token_timeout'),'old client viewport cancel killed new task');
 PERFORM recoverable_test.report(k,'not_observed','page_left');
 PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','leaving lost a recoverable reply');
 result:=visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=30,'normal completion not charged');
 PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE debit_key=k::text),'duplicate recoverable charge');
 PERFORM recoverable_test.report(k,'observed',NULL,1500,true,20000);
 PERFORM vip_t4_test.assert((SELECT client_outcome='observed' AND client_first_token_visible_ms=20000 AND client_backgrounded FROM experience.chat_generation_requests WHERE chat_history_id=k),'return display not recorded or idle misclassified');

 k:='00000000-0000-4000-8000-0000000002a2';
 PERFORM recoverable_test.start(k); PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='pending','charged before receipt deadline arbitration');
 PERFORM recoverable_test.report(k,'timed_out','not_visible');
 result:=visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=0,'genuine foreground no-delivery charged');
 PERFORM recoverable_test.report(k,'observed',NULL,12000,false,12100);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','late display reopened failed eligibility');

 k:='00000000-0000-4000-8000-0000000002a3';
 PERFORM recoverable_test.start(k); PERFORM recoverable_test.report(k,'timed_out','not_visible',2000);
 PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','old viewport false timeout waived received reply');

 k:='00000000-0000-4000-8000-0000000002a4';
 PERFORM recoverable_test.start(k);
 PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
 PERFORM recoverable_test.report(k,'not_observed','page_left');
 PERFORM vip_t4_test.assert((SELECT status='reserved' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'leaving released a live entitlement');
 PERFORM recoverable_test.complete(k);
 result:=billing.finalize_character_free_chat_round(k,true);
 PERFORM vip_t4_test.assert(result->>'status'='consumed','background complete did not consume entitlement');
 SELECT used_rounds INTO q FROM billing.character_free_chat_quotas WHERE user_id='00000000-0000-4000-8000-0000000000e1' AND character_id='00000000-0000-4000-8000-0000000000e2';
 PERFORM billing.finalize_character_free_chat_round(k,true);
 PERFORM vip_t4_test.assert((SELECT used_rounds=q FROM billing.character_free_chat_quotas WHERE user_id='00000000-0000-4000-8000-0000000000e1' AND character_id='00000000-0000-4000-8000-0000000000e2'),'double quota');

 k:='00000000-0000-4000-8000-0000000002a5';
 PERFORM recoverable_test.start(k);
 PERFORM experience.record_chat_delivery_preview(k,0,3000,'delta','partial');
 UPDATE experience.chat_generation_requests SET request_received_at=now()-interval '30 sec' WHERE chat_history_id=k;
 PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'user_stop');
 PERFORM vip_t4_test.assert((SELECT llm_finish_reason='user_cancelled' FROM experience.chat_history WHERE id=k),'stop after ready misclassified timeout');
 result:=user_stop_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=29,'manual stop repriced or waived');

 k:='00000000-0000-4000-8000-0000000002a6';
 PERFORM recoverable_test.start(k);
 UPDATE experience.chat_generation_requests SET first_token_timeout=true,server_timeout_stage='fallback' WHERE chat_history_id=k;
 PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'user_stop');
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','system cutoff became a paid stop');
 PERFORM vip_t4_test.assert(NOT experience.record_chat_delivery_preview(k,0,2500,'delta','late'),'late checkpoint changed terminal winner');
 PERFORM vip_t4_test.assert(NOT has_function_privilege('authenticated','experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)','EXECUTE'),'public checkpoint writer');
 PERFORM vip_t4_test.assert(NOT has_column_privilege('grafana_cloud','experience.chat_history','first_token_preview','SELECT'),'analytics can read private preview');
END $$;

UPDATE experience.chat_generation_requests SET requested_model_id='recoverable-model',request_received_at='2026-10-26 12:00:00+08' WHERE recoverable_delivery;
