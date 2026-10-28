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

-- v4 uses React commit, never viewport visibility or network reception.
CREATE FUNCTION recoverable_test.start_v4(k uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO experience.chat_history(id,user_id,session_id,llm_charge_id,revision,status,llm_billing_snapshot)
 VALUES(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',k,0,'streaming',
   jsonb_build_object('charge_id',k,'billing_mode','fixed_tier','payable_credits',29,'fixed_deduction',29,
     'original_credits',30,'discount_rate',0.95,'wallet_policy','main_only','requires_vip',true,'vip_active',true));
 PERFORM experience.begin_chat_generation_observation(k,jsonb_build_object(
   'request_id',k,'primary_attempt_id',gen_random_uuid(),'requested_model_id','client-v4-model',
   'provider','openrouter','model','fixture/selected','received_at',clock_timestamp(),
   'timeout_ms',4000,'fallback_timeout_ms',2000,'deadline_ms',10000,'timeout_rate_target',0.01,
   'catalog_version',1,'mode','send','recoverable_delivery',true,'measurement_method','client_committed_v4'));
END $$;
CREATE FUNCTION recoverable_test.report_v4(k uuid, outcome text, reason text, received numeric DEFAULT NULL,
 hidden boolean DEFAULT false, committed numeric DEFAULT NULL) RETURNS boolean LANGUAGE sql AS $$
 SELECT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',jsonb_build_object(
 'assistant_message_id',k,'request_id',k,'revision',0,'outcome',outcome,'reason',reason,
 'first_token_received_ms',received,'first_token_visible_ms',committed,'backgrounded',hidden,
 'measurement_method','client_committed_v4','wait_finished_ms',COALESCE(committed,10000)));
$$;
DO $$ DECLARE k uuid; result jsonb; before_row jsonb; after_row jsonb; old_report jsonb; BEGIN
 SELECT to_jsonb(r) INTO old_report FROM experience.chat_generation_requests r
 WHERE chat_history_id='00000000-0000-4000-8000-0000000002a1';
 k:='00000000-0000-4000-8000-0000000002b1';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert((SELECT measurement_method='client_committed_v4' AND client_outcome='missing' FROM experience.chat_generation_requests WHERE chat_history_id=k),'v4 missing cohort was not frozen at acceptance');
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,3200);
 SELECT to_jsonb(r)||jsonb_build_object('ctid',r.ctid::text) INTO before_row FROM experience.chat_generation_requests r WHERE chat_history_id=k;
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,3200);
 PERFORM recoverable_test.report_v4(k,'timed_out','not_visible',2000);
 PERFORM vip_t4_test.assert(NOT recoverable_test.report(k,'observed',NULL,2000,false,20000),'legacy receipt downgraded v4');
 SELECT to_jsonb(r)||jsonb_build_object('ctid',r.ctid::text) INTO after_row FROM experience.chat_generation_requests r WHERE chat_history_id=k;
 PERFORM vip_t4_test.assert(before_row=after_row,'duplicate v4 receipt performed UPDATE or replaced first terminal');
 result:=visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=30,'on-time v4 commit failed to settle');
 PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE debit_key=k::text),'v4 commit double charged');

 k:='00000000-0000-4000-8000-0000000002b2';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
 PERFORM recoverable_test.report_v4(k,'timed_out','not_visible',2000);
 PERFORM vip_t4_test.assert((SELECT client_delivery_failed FROM experience.chat_generation_requests WHERE chat_history_id=k),'early reception bypassed v4 commit deadline');
 PERFORM vip_t4_test.assert((SELECT status='released' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'v4 cutoff did not promptly release quota');
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,14500);
 PERFORM vip_t4_test.assert((SELECT client_outcome='timed_out' AND client_first_token_visible_ms IS NULL FROM experience.chat_generation_requests WHERE chat_history_id=k),'late recovered v4 reply rewrote timeout');
 result:=visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=0,'v4 late commit charged stars');

 k:='00000000-0000-4000-8000-0000000002b3';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,10000);
 PERFORM vip_t4_test.assert((SELECT client_outcome='timed_out' AND client_reason='not_visible' AND client_delivery_failed AND client_first_token_visible_ms IS NULL FROM experience.chat_generation_requests WHERE chat_history_id=k),'deadline equality accepted as observed');
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','deadline equality did not waive charge');

 k:='00000000-0000-4000-8000-0000000002b4';
 PERFORM recoverable_test.start_v4(k);
 PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
 PERFORM recoverable_test.report_v4(k,'not_observed','page_left');
 PERFORM vip_t4_test.assert((SELECT status='reserved' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'v4 departure released live reservation');
 PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','v4 departure prevented recovered completion charge');
 result:=billing.finalize_character_free_chat_round(k,true);
 PERFORM vip_t4_test.assert(result->>'status'='consumed','v4 recovered completion failed quota settlement');
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,30000);
 PERFORM vip_t4_test.assert((SELECT client_outcome='not_observed' AND client_reason='page_left' AND NOT client_delivery_failed FROM experience.chat_generation_requests WHERE chat_history_id=k),'recovery changed v4 departure into foreground success/failure');

 k:='00000000-0000-4000-8000-0000000002b5';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.report_v4(k,'not_observed','page_left',NULL,true);
 PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','background v4 completion became free');

 k:='00000000-0000-4000-8000-0000000002b6';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.report_v4(k,'not_observed','cancelled');
 PERFORM experience.cancel_chat_generation('00000000-0000-0000-0000-000000000090',k,'user_stop');
 result:=user_stop_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=29,'v4 manual stop became free or repriced');
 PERFORM user_stop_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE debit_key=k::text),'v4 manual stop double charged');

 k:='00000000-0000-4000-8000-0000000002b7';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 UPDATE experience.chat_generation_requests SET request_received_at=now()-interval '30 sec' WHERE chat_history_id=k;
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','v4 missing receipt bypassed conservative settlement');

 k:='00000000-0000-4000-8000-0000000002b8';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.report_v4(k,'not_observed','upstream_error');
 UPDATE experience.chat_history SET status='upstream_error',llm_finish_reason='upstream_error' WHERE id=k;
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','upstream failure charged without text');

 k:='00000000-0000-4000-8000-0000000002b9';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.report_v4(k,'not_observed','fallback_timeout');
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','v4 fallback no-token timeout charged');
 PERFORM vip_t4_test.assert((SELECT to_jsonb(r)=old_report FROM experience.chat_generation_requests r WHERE chat_history_id='00000000-0000-4000-8000-0000000002a1'),'v4 rewrote legacy rows');
 -- Same model, historical v3: never contribute its late display to v4's sample count/P95.
 k:='00000000-0000-4000-8000-0000000002ba';
 PERFORM recoverable_test.start(k); PERFORM recoverable_test.report(k,'observed',NULL,2000,false,16000);
 UPDATE experience.chat_generation_requests SET requested_model_id='client-v4-model',request_received_at='2026-10-26 12:00:00+08' WHERE chat_history_id=k;
END $$;
UPDATE experience.chat_generation_requests SET request_received_at='2026-10-26 12:00:00+08'
 WHERE measurement_method='client_committed_v4';
DO $$ DECLARE report jsonb; BEGIN
 SELECT j INTO report FROM miniapp_analytics.chat_first_token_report('2026-10-26 00:00:00+08','2026-10-27 00:00:00+08') j
 WHERE j->>'model_id'='client-v4-model' AND j->>'measurement_method'='client_committed_v4';
 PERFORM vip_t4_test.assert((report->>'requests')::int=9 AND (report->>'model_requests')::int=9,'v4 mixed historical cohort or lost missing receipts');
 PERFORM vip_t4_test.assert((report->>'user_first_token_p95_ms')::numeric=3200,'v4 success distribution included deadline/legacy/late recovery');
 PERFORM vip_t4_test.assert((report->>'foreground_known_result_samples')::int=5 AND (report->>'foreground_time_cutoff_samples')::int=3 AND (report->>'foreground_time_cutoff_rate_known')::numeric=0.6,'v4 cutoff denominator includes leave/background/missing/stop');
 PERFORM vip_t4_test.assert((report->>'missing_client_reports')::int=1 AND (report->>'page_left_requests')::int=2 AND (report->>'backgrounded_requests')::int=1,'v4 lost coverage exclusions');
 PERFORM vip_t4_test.assert(NOT has_function_privilege('grafana_cloud','experience.report_chat_first_token(uuid,uuid,jsonb)','EXECUTE') AND NOT has_function_privilege('authenticated','experience.begin_chat_generation_observation(uuid,jsonb)','EXECUTE'),'v4 broadened writer ACL');
END $$;
