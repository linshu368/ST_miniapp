-- Synthetic local-only regression; never execute against shared TEST/Production.
CREATE SCHEMA surplus_history_test;
CREATE FUNCTION surplus_history_test.assert(p_ok boolean,p_message text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%',p_message; END IF; END $$;
CREATE FUNCTION surplus_history_test.begin_turn(p_history uuid,p_attempt uuid,p_charge uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO experience.chat_history(id,model,llm_charge_id,revision) VALUES(p_history,'surplus-model',p_charge,0);
  PERFORM experience.begin_chat_generation_observation(p_history,jsonb_build_object(
    'request_id',gen_random_uuid(),'primary_attempt_id',p_attempt,'requested_model_id','surplus-selected',
    'provider','surplus','model','surplus-model','received_at',clock_timestamp(),'timeout_ms',4000,
    'fallback_timeout_ms',2000,'fallback_model_id','deepseek/deepseek-v4.1-flash-1017','deadline_ms',6000,'timeout_rate_target',0.01,'catalog_version',1,'mode','send',
    'snapshot',jsonb_build_object('charge_id',p_charge,'provider','surplus','provider_model_id','surplus-model','fixed_deduction',30)));
END;
$$;

DO $$
DECLARE catalog jsonb; h uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); c uuid:=gen_random_uuid();
  h2 uuid:=gen_random_uuid(); a2 uuid:=gen_random_uuid(); s experience.surplusintelligence_chat_history%ROWTYPE;
  params jsonb:='{"model":"surplus-model","stream":true,"stream_options":{"include_usage":true},"temperature":0}'; detail text;
BEGIN
  catalog:='{"default_model_id":"m","tiers":[{"tier":"light","label":"Light","color":"#abcdef","cost_hint":"test","sort_order":0,"models":[{"id":"m","provider":"surplus","provider_model_id":"surplus-model","openrouter_model_id":"surplus-model","display_name":"M","tagline":"test","enabled":true,"is_free":false,"sort_order":0}]}]}';
  PERFORM admin.validate_model_catalog_core(catalog);
  PERFORM admin.validate_model_catalog_prd(catalog);
  BEGIN
    PERFORM admin.validate_model_catalog_core(jsonb_set(catalog,'{tiers,0,models,0,provider}','"unrecognized"'));
    RAISE EXCEPTION 'Unknown provider accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM surplus_history_test.assert((SELECT relrowsecurity FROM pg_class WHERE oid='experience.surplusintelligence_chat_history'::regclass),'Surplus RLS disabled');
  PERFORM surplus_history_test.assert(NOT has_table_privilege('anon','experience.surplusintelligence_chat_history','SELECT')
    AND NOT has_table_privilege('authenticated','experience.surplusintelligence_chat_history','INSERT')
    AND NOT has_table_privilege('first_token_metrics_reader','experience.surplusintelligence_chat_history','SELECT')
    AND NOT has_function_privilege('authenticated','experience.record_surplusintelligence_call(uuid,jsonb)','EXECUTE'),'Unexpected public Surplus access');
  PERFORM surplus_history_test.begin_turn(h,a,c);
  PERFORM surplus_history_test.begin_turn(h2,a2,gen_random_uuid());
  PERFORM experience.prepare_surplusintelligence_call(h,a,params);
  PERFORM experience.prepare_surplusintelligence_call(h,a,params);
  BEGIN
    PERFORM experience.prepare_surplusintelligence_call(h,a,params||'{"temperature":1}');
    RAISE EXCEPTION 'Request parameters rebound';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  BEGIN
    PERFORM experience.prepare_surplusintelligence_call(h,a2,params);
    RAISE EXCEPTION 'Foreign attempt accepted';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  BEGIN
    PERFORM experience.prepare_surplusintelligence_call(h,a,params||'{"messages":[]}');
    RAISE EXCEPTION 'Request content accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM experience.record_surplusintelligence_call(h,'{"generation_id":"generation-one","request_id":"request-one","call_status":"dispatched","completion_tokens":0,"total_tokens":0,"response_metadata":{"stream":{"id":"generation-one","usage":{"completion_tokens":0}}}}');
  PERFORM experience.record_surplusintelligence_call(h,'{"generation_id":"generation-one","request_id":"request-one","call_status":"completed","http_status":200,"finish_reason":"stop","prompt_tokens":0,"completion_tokens":12,"total_tokens":12,"cached_tokens":0,"reasoning_tokens":0,"buyer_cost_micro":"999999999999999999999999999999","usage_usd":"999999999999999999999999.999999","latency_ms":0,"generation_time_ms":42,"metadata_capture_status":"complete","response_metadata":{"headers":{"x-si-served-by":"marketplace","x-si-marketplace-attempts":"2","retry-after":"3"},"stream":{"id":"generation-one","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":0}}},"capture":{"schema_version":1,"status":"complete","stream_completed":true}}}');
  PERFORM experience.record_surplusintelligence_call(h,'{"call_status":"dispatched","generation_id":"generation-one","response_metadata":{"stream":{"id":null,"usage":null},"capture":{"stream_completed":null}}}');
  SELECT * INTO STRICT s FROM experience.surplusintelligence_chat_history WHERE chat_history_id=h;
  PERFORM surplus_history_test.assert(s.call_status='completed' AND s.generation_id='generation-one' AND s.request_id='request-one','Terminal call/IDs regressed');
  PERFORM surplus_history_test.assert(s.prompt_tokens=0 AND s.completion_tokens=12 AND s.total_tokens=12 AND s.cached_tokens=0 AND s.latency_ms=0 AND s.buyer_cost_micro=999999999999999999999999999999,'Terminal usage/zero/cost precision lost');
  PERFORM surplus_history_test.assert(s.response_metadata#>>'{stream,usage,completion_tokens_details,reasoning_tokens}'='0'
    AND s.response_metadata#>>'{stream,id}'='generation-one' AND s.response_metadata#>>'{capture,stream_completed}'='true','Nested facts cleared by null');
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,'{"generation_id":"different"}');
    RAISE EXCEPTION 'Generation identity rebound';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,'{"request_id":"different"}');
    RAISE EXCEPTION 'Request identity rebound';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,'{"response_metadata":{"body":{"choices":[{"message":{"content":"synthetic private text"}}]}}}');
    RAISE EXCEPTION 'Nested conversation content accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,'{"response_metadata":{"headers":{"authorization":"synthetic forbidden value"}}}');
    RAISE EXCEPTION 'Credential header accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
    PERFORM surplus_history_test.assert(COALESCE(detail,'')='','Unsafe rejected row leaked into error details');
  END;
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,jsonb_build_object('response_metadata',jsonb_build_object('body',jsonb_build_object('model',repeat('a',131073)))));
    RAISE EXCEPTION 'Oversized metadata accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM experience.prepare_surplusintelligence_call(h2,a2,params||jsonb_build_object('stop',jsonb_build_array(repeat('a',16385))));
    RAISE EXCEPTION 'Oversized request accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,'{"buyer_cost_micro":"1.5"}');
    RAISE EXCEPTION 'Fractional microdollars rounded instead of rejected';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM experience.prepare_surplusintelligence_call(h2,a2,params);
  PERFORM experience.record_surplusintelligence_call(h2,'{"request_id":"stale-request","call_status":"dispatched"}');
  PERFORM surplus_history_test.assert(NOT experience.claim_surplusintelligence_request_record(h2,clock_timestamp()),'Live dispatch metadata claimed');
  PERFORM surplus_history_test.assert(experience.claim_surplusintelligence_request_record(h2,clock_timestamp()+interval '121 seconds'),'Stale dispatch metadata cannot recover');
  PERFORM experience.record_surplusintelligence_call(h2,'{"request_record_status":"forbidden"}');
  PERFORM experience.record_surplusintelligence_call(h2,'{"request_record_status":"pending"}');
  PERFORM surplus_history_test.assert(NOT experience.claim_surplusintelligence_request_record(h2,clock_timestamp()+interval '1 day'),'Forbidden request-log status reopened');
  PERFORM surplus_history_test.assert(experience.claim_surplusintelligence_request_record(h,clock_timestamp()),'First request-log claim rejected');
  PERFORM surplus_history_test.assert(NOT experience.claim_surplusintelligence_request_record(h,clock_timestamp()),'Duplicate request-log claim accepted');
  PERFORM experience.record_surplusintelligence_call(h,'{"request_record_status":"complete","buyer_cost_micro":"23","usage_usd":"0.000023","completion_tokens":13,"model":"actual-settled-model","response_metadata":{"request_record":{"id":"request-one","status":"completed","usage":{"prompt_tokens":0,"completion_tokens":13,"buyer_cost_micro":"23"}},"capture":{"observed_sources":["headers","stream","request_record"]}}}');
  PERFORM experience.record_surplusintelligence_call(h,'{"buyer_cost_micro":"10","usage_usd":"0.000010","completion_tokens":12,"model":"late-inline-model"}');
  PERFORM surplus_history_test.assert((SELECT buyer_cost_micro=23 AND usage_usd=0.000023 AND completion_tokens=13 AND model='actual-settled-model'
    AND response_metadata#>>'{stream,usage,completion_tokens}'='12' FROM experience.surplusintelligence_chat_history WHERE chat_history_id=h),'Settled detail projection or earlier inline evidence lost');
  BEGIN
    PERFORM experience.record_surplusintelligence_call(h,'{"request_record_status":"complete","buyer_cost_micro":"25","response_metadata":{"request_record":{"id":"other-request","buyer_cost_micro":"25"}}}');
    RAISE EXCEPTION 'Foreign request detail replaced scalar cost';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
  PERFORM surplus_history_test.assert(NOT experience.claim_surplusintelligence_request_record(h,clock_timestamp()+interval '1 day'),'Completed request-log claimed again');
  PERFORM experience.observe_chat_generation_attempt(h,jsonb_build_object('id',a,'role','primary','provider','surplus','model','surplus-model','generation_id','generation-one'));
  PERFORM experience.select_chat_generation_delivery(h,a,'generation-one');
  PERFORM experience.select_chat_generation_delivery(h,a,'generation-one');
  PERFORM surplus_history_test.assert(NOT EXISTS(SELECT 1 FROM experience.venice_chat_history WHERE chat_history_id=h),'Surplus written into Venice');
  PERFORM surplus_history_test.assert((SELECT llm_billing_snapshot->>'provider'='surplus' FROM experience.chat_history WHERE id=h),'Surplus delivery lost its provider');
  DELETE FROM experience.chat_history WHERE id=h;
  PERFORM surplus_history_test.assert(NOT EXISTS(SELECT 1 FROM experience.surplusintelligence_chat_history WHERE chat_history_id=h),'Surplus detail did not cascade');
END;
$$;

DO $$
DECLARE h uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); before_content text;
BEGIN
  PERFORM surplus_history_test.begin_turn(h,a,c);
  SELECT user_input INTO before_content FROM experience.chat_history WHERE id=h;
  PERFORM experience.prepare_surplusintelligence_call(h,a,'{"model":"surplus-model","stream":true}');
  PERFORM experience.record_surplusintelligence_call(h,'{"generation_id":"losing-surplus","call_status":"dispatched","response_metadata":{"headers":{"x-si-served-by":"marketplace"}}}');
  PERFORM experience.prepare_chat_generation_fallback(h,f,4000);
  PERFORM experience.observe_chat_generation_attempt(h,jsonb_build_object('id',f,'role','fallback','provider','openrouter','model','deepseek/deepseek-v4.1-flash-1017','generation_id','winning-or'));
  PERFORM experience.select_chat_generation_delivery(h,f,'winning-or');
  PERFORM experience.record_surplusintelligence_call(h,'{"call_status":"interrupted","finish_reason":"stop","response_metadata":{"stream":{"usage":{"completion_tokens":3}}}}');
  PERFORM surplus_history_test.assert(EXISTS(SELECT 1 FROM experience.surplusintelligence_chat_history WHERE chat_history_id=h AND generation_id='losing-surplus'),'Surplus loser disappeared');
  PERFORM surplus_history_test.assert(EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=h AND llm_generation_id='winning-or'),'OR winner blocked by Surplus loser');
  PERFORM surplus_history_test.assert((SELECT llm_billing_snapshot->>'provider'='openrouter' AND llm_charge_id=c AND user_input=before_content FROM experience.chat_history WHERE id=h),'Late Surplus mutated billing/content');
  BEGIN
    PERFORM experience.select_chat_generation_delivery(h,a,'losing-surplus');
    RAISE EXCEPTION 'Late Surplus reclaimed delivery';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
END;
$$;

-- Privileged application role works through RLS; user/metrics roles remain denied.
GRANT USAGE ON SCHEMA surplus_history_test TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA surplus_history_test TO service_role;
SET ROLE service_role;
SELECT surplus_history_test.assert((SELECT count(*)>0 FROM experience.surplusintelligence_chat_history),'Service role cannot read own call facts');
DO $$
DECLARE h uuid:=gen_random_uuid(); a uuid:=gen_random_uuid();
BEGIN
  PERFORM surplus_history_test.begin_turn(h,a,gen_random_uuid());
  PERFORM experience.prepare_surplusintelligence_call(h,a,'{"model":"surplus-model","stream":false}');
  PERFORM experience.record_surplusintelligence_call(h,'{"generation_id":"service-role-id","call_status":"failed","http_status":429,"response_metadata":{"headers":{"retry-after":"10"}}}');
  PERFORM surplus_history_test.assert((SELECT generation_id='service-role-id' FROM experience.surplusintelligence_chat_history WHERE chat_history_id=h),'Application role cannot write RPC through RLS');
END;
$$;
RESET ROLE;
DO $$
DECLARE original_oid oid; original_owner oid; original_acl aclitem[]; d text;
BEGIN
  SELECT oid,proowner,proacl INTO original_oid,original_owner,original_acl FROM pg_proc
    WHERE oid='experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure;
  d:=pg_get_functiondef(original_oid);
  PERFORM surplus_history_test.assert(position('PT409' IN d)>0 AND position('40001' IN d)=0
    AND position('Primary cannot reclaim delivery after fallback' IN d)=0,'Delivery race/conflict contract regressed');
  PERFORM surplus_history_test.assert(NOT has_function_privilege('anon',original_oid,'EXECUTE'),'Delivery ACL changed');
END;
$$;
DROP SCHEMA surplus_history_test CASCADE;
