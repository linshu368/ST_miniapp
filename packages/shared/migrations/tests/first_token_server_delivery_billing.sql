-- Local synthetic fixtures only. Never apply this test to a remote database.
DO $$ DECLARE k uuid; result jsonb; used integer; BEGIN
 UPDATE billing.user_wallets SET main_credits=main_credits+200 WHERE user_id='00000000-0000-4000-8000-0000000000e1';

 -- The browser's deadline passed, the server was on time and the reply completed.
 k:='00000000-0000-4000-8000-0000000004f1';
 PERFORM recoverable_test.start_v4(k);
 PERFORM recoverable_test.report_v4(k,'timed_out','not_visible');
 PERFORM vip_t4_test.assert((SELECT client_outcome='timed_out' AND NOT client_delivery_failed FROM experience.chat_generation_requests WHERE chat_history_id=k),'client deadline was treated as a delivery failure');
 PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','on-time server reply was waived by the browser clock');
 result:=visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=30,'on-time server reply not charged');
 PERFORM visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((SELECT count(*)=1 FROM billing.wallet_ledger WHERE debit_key=k::text),'on-time server reply charged twice');

 -- A free round stays reserved through the browser deadline, then consumes on completion.
 k:='00000000-0000-4000-8000-0000000004f2';
 PERFORM recoverable_test.start_v4(k);
 PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
 PERFORM recoverable_test.report_v4(k,'timed_out','not_visible');
 PERFORM vip_t4_test.assert((SELECT status='reserved' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'browser deadline released a live free round');
 PERFORM recoverable_test.complete(k);
 result:=billing.finalize_character_free_chat_round(k,true);
 PERFORM vip_t4_test.assert(result->>'status'='consumed','delivered free round was not consumed');

 -- A late commit keeps the v4 measurement but no longer decides billing.
 k:='00000000-0000-4000-8000-0000000004f3';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,10000);
 PERFORM vip_t4_test.assert((SELECT client_outcome='timed_out' AND client_reason='not_visible' AND NOT client_delivery_failed FROM experience.chat_generation_requests WHERE chat_history_id=k),'late commit measurement changed');
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','late commit waived an on-time server reply');

 -- A failure relayed from the server still waives and releases immediately.
 k:='00000000-0000-4000-8000-0000000004f4';
 PERFORM recoverable_test.start_v4(k);
 PERFORM billing.reserve_character_free_chat_round(k,'00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000e2',50);
 PERFORM recoverable_test.report_v4(k,'not_observed','server_timeout');
 PERFORM vip_t4_test.assert((SELECT client_delivery_failed FROM experience.chat_generation_requests WHERE chat_history_id=k),'relayed server failure not recorded');
 PERFORM vip_t4_test.assert((SELECT status='released' FROM billing.character_free_chat_quota_decisions WHERE charge_key=k),'relayed server failure kept the reservation');
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','relayed server failure was billable');

 -- The server's own cutoff waives even after an earlier browser deadline report.
 k:='00000000-0000-4000-8000-0000000004f5';
 PERFORM recoverable_test.start_v4(k);
 PERFORM recoverable_test.report_v4(k,'timed_out','not_visible');
 UPDATE experience.chat_generation_requests SET first_token_timeout=true,server_timeout_stage='global' WHERE chat_history_id=k;
 UPDATE experience.chat_history SET status='stream_interrupted',llm_finish_reason='timeout' WHERE id=k;
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','server cutoff was billable');
 result:=visible_billing_test.charge(k);
 PERFORM vip_t4_test.assert((result#>>'{charge,charged_amount}')::numeric=0,'server cutoff charged stars');

 -- A first token at the frozen budget is the server's lateness, not the user's network.
 k:='00000000-0000-4000-8000-0000000004f6';
 PERFORM recoverable_test.start_v4(k);
 PERFORM recoverable_test.report_v4(k,'timed_out','not_visible');
 PERFORM recoverable_test.complete(k);
 UPDATE experience.chat_generation_requests SET server_first_token_ready_ms=first_token_deadline_ms WHERE chat_history_id=k;
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','late server first token was billable');

 -- With no receipt at all there is no evidence of delivery; keep the conservative path.
 k:='00000000-0000-4000-8000-0000000004f7';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='pending','missing receipt stopped waiting for arbitration');

 -- A row failed under the previous rule is not re-judged by this migration.
 k:='00000000-0000-4000-8000-0000000004f8';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM recoverable_test.report_v4(k,'observed',NULL,2000,false,3000);
 UPDATE experience.chat_generation_requests SET client_delivery_failed=true WHERE chat_history_id=k;
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='waived','pre-migration failure was re-judged');

 -- Page departure keeps its existing billing and reservation behaviour.
 k:='00000000-0000-4000-8000-0000000004f9';
 PERFORM recoverable_test.start_v4(k); PERFORM recoverable_test.complete(k);
 PERFORM recoverable_test.report_v4(k,'not_observed','page_left',NULL,true);
 PERFORM vip_t4_test.assert(billing.chat_delivery_billing_gate(k)='visible','departure lost a durable reply');
END $$;
