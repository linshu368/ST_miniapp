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
-- Race policy: two attempts remain diagnostics for one original charge/request.
-- These helpers are local fixtures only; neither is installed in a deployed schema.
CREATE FUNCTION recoverable_test.race_start(k uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a experience.chat_generation_attempts%ROWTYPE;
BEGIN
 PERFORM recoverable_test.start_v4(k);
 UPDATE experience.chat_generation_requests SET requested_model_id='race-fixture' WHERE chat_history_id=k;
 PERFORM experience.prepare_chat_generation_fallback(k,gen_random_uuid(),4000);
 FOR a IN SELECT * FROM experience.chat_generation_attempts WHERE chat_history_id=k LOOP
  PERFORM experience.observe_chat_generation_attempt(k,jsonb_build_object('id',a.id,'role',a.role,
   'provider',a.provider,'model',a.provider_model_id,'generation_id','race-'||a.id,
   'dispatch_offset_ms',CASE WHEN a.role='primary' THEN 0 ELSE 4000 END,
   'first_token_ms',CASE WHEN a.role='primary' THEN 5100 ELSE 3000 END,'end_reason','first_token_observed'));
 END LOOP;
END $$;
CREATE FUNCTION recoverable_test.race_claim(k uuid, attempt_role text, hold_lock boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE a experience.chat_generation_attempts%ROWTYPE; BEGIN
 SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE chat_history_id=k AND role=attempt_role;
 PERFORM experience.select_chat_generation_delivery(k,a.id,a.generation_id);
 IF hold_lock THEN PERFORM pg_sleep(0.4); END IF;
 RETURN true;
EXCEPTION WHEN SQLSTATE 'PT409' THEN RETURN false;
END $$;
CREATE FUNCTION recoverable_test.race_finish(k uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a experience.chat_generation_attempts%ROWTYPE; quote jsonb;
BEGIN
 SELECT winner.* INTO STRICT a FROM experience.chat_generation_requests r
 JOIN experience.chat_generation_attempts winner ON winner.id=r.delivery_attempt_id WHERE r.chat_history_id=k;
 SELECT llm_billing_snapshot INTO quote FROM experience.chat_history WHERE id=k;
 PERFORM vip_t4_test.assert(quote->>'charge_id'=k::text AND (quote->>'payable_credits')::numeric=29
   AND quote->>'provider_model_id'=a.provider_model_id,'winner changed the frozen original quote');
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM experience.openrouter_chat_history WHERE chat_history_id=k)
   AND (SELECT llm_generation_id=a.generation_id FROM experience.openrouter_chat_history WHERE chat_history_id=k),
   'loser entered billing metadata or winner identity changed');
 PERFORM vip_t4_test.assert(NOT recoverable_test.race_claim(k,CASE WHEN a.role='primary' THEN 'fallback' ELSE 'primary' END),
   'second attempt reclaimed chosen delivery');
 PERFORM experience.record_chat_delivery_preview(k,0,7200,'delta','winning reply');
 UPDATE experience.chat_history SET status='success',llm_finish_reason='stop',assistant_reply='winning reply' WHERE id=k;
 PERFORM recoverable_test.report_v4(k,'observed',NULL,7200,false,7300);
END $$;
DO $$
DECLARE k uuid:='00000000-0000-4000-8000-0000000002d1'; a experience.chat_generation_attempts%ROWTYPE;
 payload jsonb; saved jsonb; before_tid text; bad jsonb;
BEGIN
 PERFORM recoverable_test.race_start(k);
 PERFORM vip_t4_test.assert(recoverable_test.race_claim(k,'primary'),'primary could not win after fallback started');
 PERFORM vip_t4_test.assert(recoverable_test.race_claim(k,'primary'),'winner replay not idempotent');
 SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE chat_history_id=k AND role='fallback';
 payload:=jsonb_build_object('id',a.id,'role',a.role,'provider',a.provider,'model',a.provider_model_id);
 BEGIN
  UPDATE experience.chat_generation_attempts SET discarded_response=jsonb_build_object(
   'reason',NULL,'content','','reasoning','','truncated',false) WHERE id=a.id;
  RAISE EXCEPTION 'JSON null bypassed loser snapshot CHECK';
 EXCEPTION WHEN check_violation THEN NULL; END;
 FOREACH bad IN ARRAY ARRAY['null'::jsonb,'[]','{}','{"reason":null,"content":"","reasoning":"","truncated":false}',
   '{"reason":"race_lost","content":1,"reasoning":"","truncated":false}',
   '{"reason":"race_lost","content":"","reasoning":"","truncated":"false"}'] LOOP
  BEGIN
   PERFORM experience.observe_chat_generation_attempt(k,payload||jsonb_build_object('discarded_response',bad));
   RAISE EXCEPTION 'Malformed loser snapshot accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 PERFORM experience.observe_chat_generation_attempt(k,payload||jsonb_build_object('discarded_response',jsonb_build_object(
   'reason','race_lost','content',repeat('界',2200),'reasoning','public reasoning','truncated',false,'private_provider_object','must disappear')));
 SELECT discarded_response,ctid::text INTO saved,before_tid FROM experience.chat_generation_attempts WHERE id=a.id;
 PERFORM vip_t4_test.assert(length(saved->>'content')=2048 AND saved->>'reasoning'='public reasoning'
   AND (saved->>'truncated')::boolean AND NOT saved ? 'private_provider_object','diagnostic allowlist/truncation failed');
 PERFORM experience.observe_chat_generation_attempt(k,payload||jsonb_build_object('discarded_response',jsonb_build_object(
   'reason','race_lost','content','replacement','reasoning',repeat('x',9000),'truncated',true)));
 PERFORM vip_t4_test.assert((SELECT discarded_response=saved AND ctid::text=before_tid AND end_reason='cancelled'
   FROM experience.chat_generation_attempts WHERE id=a.id),'replayed loser snapshot overwrote data or performed UPDATE');
 PERFORM recoverable_test.race_finish(k);
 PERFORM visible_billing_test.charge(k); PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 AND sum(abs(amount))=30 FROM billing.wallet_ledger WHERE debit_key=k::text),
   'primary after fallback charged more than once');
 PERFORM vip_t4_test.assert((SELECT assistant_reply='winning reply' FROM experience.chat_history WHERE id=k),'loser diagnostic leaked into user reply');
 -- A second fixture is claimed concurrently from independent psql connections.
 PERFORM recoverable_test.race_start('00000000-0000-4000-8000-0000000002d2');
END $$;
-- Fallback intent/diagnostic writes can arrive after primary delivery has already
-- completed. Storage latency must not force delivery to wait or lose its audit.
DO $$
DECLARE k uuid:='00000000-0000-4000-8000-0000000002d3'; p uuid; f uuid:=gen_random_uuid();
 model_name text; winner_before uuid; tid_before text; before_quote jsonb; bad_time numeric;
BEGIN
 PERFORM recoverable_test.start_v4(k);
 UPDATE experience.chat_generation_requests SET requested_model_id='race-late-fixture' WHERE chat_history_id=k;
 SELECT id INTO p FROM experience.chat_generation_attempts WHERE chat_history_id=k AND role='primary';
 PERFORM experience.select_chat_generation_delivery(k,p,'late-intent-primary');
 PERFORM experience.record_chat_delivery_preview(k,0,5000,'delta','selected primary');
 UPDATE experience.chat_history SET status='success',llm_finish_reason='stop',assistant_reply='selected primary' WHERE id=k;
 PERFORM recoverable_test.report_v4(k,'observed',NULL,5000,false,5100);
 PERFORM visible_billing_test.charge(k);
 SELECT llm_billing_snapshot INTO before_quote FROM experience.chat_history WHERE id=k;
 SELECT delivery_attempt_id INTO winner_before FROM experience.chat_generation_requests WHERE chat_history_id=k;
 FOREACH bad_time IN ARRAY ARRAY[NULL::numeric,-1::numeric,10000::numeric,11000::numeric,'NaN'::numeric] LOOP
  BEGIN
   PERFORM experience.prepare_chat_generation_fallback(k,f,bad_time);
   RAISE EXCEPTION 'Fallback intent accepted invalid trigger time';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 PERFORM experience.prepare_chat_generation_fallback(k,f,4000);
 SELECT provider_model_id,ctid::text INTO model_name,tid_before FROM experience.chat_generation_attempts WHERE id=f;
 PERFORM experience.prepare_chat_generation_fallback(k,f,4000);
 PERFORM vip_t4_test.assert((SELECT ctid::text=tid_before FROM experience.chat_generation_attempts WHERE id=f),
   'same fallback identity replay performed UPDATE');
 BEGIN
  PERFORM experience.prepare_chat_generation_fallback(k,gen_random_uuid(),4000);
  RAISE EXCEPTION 'A second fallback identity was accepted';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
 PERFORM experience.observe_chat_generation_attempt(k,jsonb_build_object('id',f,'role','fallback','provider','openrouter',
  'model',model_name,'generation_id','late-loser','end_reason','cancelled','discarded_response',jsonb_build_object(
   'reason','race_lost','content','already received fragment','reasoning','','truncated',false)));
 PERFORM vip_t4_test.assert((SELECT delivery_attempt_id=winner_before FROM experience.chat_generation_requests WHERE chat_history_id=k)
  AND (SELECT status='success' AND assistant_reply='selected primary' AND llm_billing_snapshot=before_quote FROM experience.chat_history WHERE id=k),
  'late fallback intent changed delivery or business outcome');
 PERFORM vip_t4_test.assert((SELECT provider_model_id=(SELECT fallback_model_id FROM experience.chat_generation_requests WHERE chat_history_id=k)
  AND discarded_response->>'content'='already received fragment' FROM experience.chat_generation_attempts WHERE id=f),
  'late loser lost frozen route or diagnostic');
 PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE debit_key=k::text),'late loser caused another charge');

 k:='00000000-0000-4000-8000-0000000002d4'; f:=gen_random_uuid();
 PERFORM recoverable_test.start_v4(k);
 UPDATE experience.chat_generation_requests SET requested_model_id='race-cutoff-fixture',first_token_timeout=true,
  server_timeout_stage='global' WHERE chat_history_id=k;
 UPDATE experience.chat_history SET status='stream_interrupted',llm_finish_reason='timeout' WHERE id=k;
 PERFORM experience.prepare_chat_generation_fallback(k,f,4000);
 PERFORM vip_t4_test.assert((SELECT delivery_attempt_id IS NULL AND first_token_timeout FROM experience.chat_generation_requests WHERE chat_history_id=k),
  'late intent reopened a timed-out request');
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','late intent charged a system timeout');
END $$;
SET ROLE grafana_cloud;
SELECT count(*) FROM miniapp_analytics.chat_first_token_facts;
DO $$ BEGIN
 BEGIN
  PERFORM discarded_response FROM experience.chat_generation_attempts LIMIT 1;
  RAISE EXCEPTION 'Grafana read discarded reply content';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ DECLARE reader text; BEGIN
 FOREACH reader IN ARRAY ARRAY['first_token_metrics_reader','grafana_cloud','anon','authenticated'] LOOP
  PERFORM vip_t4_test.assert(NOT has_column_privilege(reader,'experience.chat_generation_attempts','discarded_response','SELECT'),
   'non-service role can read loser content: '||reader);
 END LOOP;
 PERFORM vip_t4_test.assert(has_column_privilege('service_role','experience.chat_generation_attempts','discarded_response','SELECT'),
   'server cannot read its diagnostic snapshot');
END $$;

-- Request-only recovery keeps ownership and the original first terminal result.
DO $$ DECLARE k uuid; other uuid; payload jsonb; before_row jsonb; after_row jsonb; result jsonb; BEGIN
 k:='00000000-0000-4000-8000-0000000003a1'; PERFORM recoverable_test.start_v4(k);
 UPDATE experience.chat_generation_requests SET first_token_deadline_ms=6000,primary_timeout_ms=2000 WHERE chat_history_id=k;
 payload:=jsonb_build_object('request_id',k,'assistant_message_id',NULL,'revision',NULL,
  'measurement_method','client_committed_v4','outcome','not_observed','reason','page_left',
  'backgrounded',true,'first_token_visible_ms',NULL,'first_token_received_ms',NULL,'wait_finished_ms',770);
 PERFORM vip_t4_test.assert(NOT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e2','00000000-0000-0000-0000-000000000090',payload),'request-only report crossed users');
 PERFORM vip_t4_test.assert(NOT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000091',payload),'request-only report crossed sessions');
 PERFORM vip_t4_test.assert(NOT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',payload||'{"outcome":"observed"}'),'request-only report invented a delivery');
 PERFORM vip_t4_test.assert(NOT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',payload||'{"revision":0}'),'partial identity was accepted');
 PERFORM vip_t4_test.assert(experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',payload),'early departure could not resolve its indexed request');
 SELECT to_jsonb(r)||jsonb_build_object('ctid',r.ctid::text) INTO before_row FROM experience.chat_generation_requests r WHERE chat_history_id=k;
 PERFORM experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',payload);
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,3000);
 SELECT to_jsonb(r)||jsonb_build_object('ctid',r.ctid::text) INTO after_row FROM experience.chat_generation_requests r WHERE chat_history_id=k;
 PERFORM vip_t4_test.assert(before_row=after_row,'recovery performed another UPDATE or changed the terminal outcome');
 PERFORM recoverable_test.complete(k); PERFORM visible_billing_test.charge(k); PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE debit_key=k::text),'departure recovery charged twice');

 k:='00000000-0000-4000-8000-0000000003a2';PERFORM recoverable_test.start_v4(k);PERFORM recoverable_test.complete(k);
 UPDATE experience.chat_generation_requests SET first_token_deadline_ms=6000,primary_timeout_ms=2000 WHERE chat_history_id=k;
 PERFORM recoverable_test.report_v4(k,'observed',NULL,5900,false,5999);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','5999ms delivery was not eligible');
 k:='00000000-0000-4000-8000-0000000003a3';PERFORM recoverable_test.start_v4(k);PERFORM recoverable_test.complete(k);
 UPDATE experience.chat_generation_requests SET first_token_deadline_ms=6000,primary_timeout_ms=2000 WHERE chat_history_id=k;
 PERFORM recoverable_test.report_v4(k,'observed',NULL,5900,false,6000);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','6000ms cutoff was charged');
 PERFORM visible_billing_test.charge(k);PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert(NOT EXISTS(SELECT 1 FROM billing.wallet_ledger WHERE debit_key=k::text),'six-second timeout debited a wallet');

 k:='00000000-0000-4000-8000-0000000003a4';other:='00000000-0000-4000-8000-0000000003a5';
 PERFORM recoverable_test.start_v4(k);PERFORM recoverable_test.start_v4(other);
 UPDATE experience.chat_generation_requests SET client_request_id=k WHERE chat_history_id=other;
 payload:=payload||jsonb_build_object('request_id',k);
 PERFORM vip_t4_test.assert(NOT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',payload),'ambiguous replay was guessed');
 PERFORM vip_t4_test.assert((SELECT count(*)=2 FROM experience.chat_generation_requests WHERE chat_history_id IN(k,other) AND client_outcome='missing'),'ambiguous lookup changed either round');
 PERFORM vip_t4_test.assert(NOT experience.report_chat_first_token('00000000-0000-4000-8000-0000000000e1','00000000-0000-0000-0000-000000000090',payload||'{"request_id":"00000000-0000-4000-8000-0000000003ff"}'),'unknown request was accepted');
END $$;
