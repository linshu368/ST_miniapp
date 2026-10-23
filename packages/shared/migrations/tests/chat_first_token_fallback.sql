-- Synthetic local scenarios; never apply to a remote environment.
DO $$
DECLARE h uuid; c uuid; p uuid; f uuid; req uuid; quote jsonb; original_quote jsonb; report jsonb; row_report jsonb; catalog jsonb; n integer;
BEGIN
  catalog := '{"default_model_id":"m","tiers":[{"tier":"light","label":"Light","color":"#abcdef","cost_hint":"test","sort_order":0,"models":[{"id":"m","provider":"venice","provider_model_id":"m","openrouter_model_id":"m","display_name":"M","tagline":"test","enabled":true,"is_free":false,"sort_order":0}]}]}'::jsonb;
  PERFORM admin.validate_model_catalog_core(catalog); PERFORM admin.validate_model_catalog_prd(catalog);
  FOR n IN 1..5 LOOP
    BEGIN
      PERFORM admin.validate_model_catalog_core(catalog || CASE n WHEN 1 THEN '{"first_token_deadline_ms":null}'::jsonb WHEN 2 THEN '{"first_token_deadline_ms":4000}' WHEN 3 THEN '{"first_token_timeout_rate_target":1.01}' WHEN 4 THEN '{"first_token_deadline_ms":"6000"}' ELSE '{"first_token_deadline_ms":6000.1}' END);
      RAISE EXCEPTION 'Invalid catalog accepted %',n;
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
  IF has_table_privilege('authenticated','experience.chat_generation_requests','SELECT') OR has_function_privilege('authenticated','experience.report_chat_first_token(uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Client bypasses reporting API'; END IF;

  FOR n IN 1..150 LOOP
    h:=gen_random_uuid(); c:=gen_random_uuid(); p:=gen_random_uuid(); f:=gen_random_uuid(); req:=gen_random_uuid();
    quote:=jsonb_build_object('charge_id',c,'model_id','selected','model_display_name','Selected Premium','provider','venice','provider_model_id','selected-source','fixed_deduction',30,'vip_active',true,'wallet_policy','main_only','original_credits',30,'discount_rate',0.95,'payable_credits',28.5);
    original_quote:=quote;
    INSERT INTO experience.chat_history(id,model,created_at,llm_charge_id,revision) VALUES(h,'selected-source','2026-10-22 10:00:00+08',c,0);
    PERFORM experience.begin_chat_generation_observation(h,jsonb_build_object('request_id',req,'primary_attempt_id',p,'requested_model_id','selected','provider','venice','model','selected-source','received_at','2026-10-22 10:00:00+08','timeout_ms',CASE WHEN n=150 THEN 3500 ELSE 4000 END,'deadline_ms',6000,'timeout_rate_target',0.01,'catalog_version',1,'mode','send','snapshot',quote));
    PERFORM experience.observe_chat_generation_attempt(h,jsonb_build_object('id',p,'role','primary','provider','venice','model','selected-source','dispatch_offset_ms',200,'headers_ms',100,'first_chunk_ms',150,'observed_until_ms',4500,'first_token_ms',4500,'end_reason','first_token_observed'));
    PERFORM experience.prepare_chat_generation_fallback(h,f,4200);
    PERFORM experience.observe_chat_generation_attempt(h,jsonb_build_object('id',f,'role','fallback','provider','openrouter','model','deepseek/deepseek-v4.1-flash','generation_id','fallback-'||n,'dispatch_offset_ms',4250,'first_token_ms',800,'provider_latency_ms',600,'end_reason','first_token_observed'));
    BEGIN
      PERFORM experience.select_chat_generation_delivery(h,p,'late-primary');
      RAISE EXCEPTION 'Late primary reclaimed delivery';
    EXCEPTION WHEN serialization_failure THEN NULL; END;
    PERFORM experience.select_chat_generation_delivery(h,f,'fallback-'||n);
    PERFORM experience.select_chat_generation_delivery(h,f,'fallback-'||n);
    SELECT llm_billing_snapshot INTO quote FROM experience.chat_history WHERE id=h;
    IF (quote-'provider'-'provider_model_id') IS DISTINCT FROM (original_quote-'provider'-'provider_model_id') OR quote->>'provider'<>'openrouter' THEN RAISE EXCEPTION 'Frozen quote changed'; END IF;
    IF EXISTS(SELECT 1 FROM experience.venice_chat_history WHERE chat_history_id=h) OR (SELECT count(*) FROM experience.openrouter_chat_history WHERE chat_history_id=h)<>1 THEN RAISE EXCEPTION 'Observer entered billing metadata'; END IF;
    report:=jsonb_build_object('assistant_message_id',h,'request_id',req,'revision',0,'outcome',CASE WHEN n=1 THEN 'timed_out' ELSE 'observed' END,'first_token_visible_ms',CASE WHEN n=1 THEN NULL ELSE 5200 END,'first_token_received_ms',5100,'request_dispatched_ms',20,'backgrounded',false,'reason',NULL,'measurement_method','visible_dom_after_frame_v1');
    IF experience.report_chat_first_token('00000000-0000-0000-0000-000000000098','00000000-0000-0000-0000-000000000090',report) THEN RAISE EXCEPTION 'Wrong owner reported'; END IF;
    IF NOT experience.report_chat_first_token('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000090',report) THEN RAISE EXCEPTION 'Valid report rejected'; END IF;
    PERFORM experience.report_chat_first_token('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000090',report||'{"outcome":"timed_out","first_token_visible_ms":null}');
    IF n=149 THEN
      SELECT r INTO row_report FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08') r LIMIT 1;
      IF (row_report->>'model_requests')::integer<>149 OR (row_report->>'sample_eligible')::boolean THEN RAISE EXCEPTION '149 samples qualified'; END IF;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM experience.chat_generation_requests)<>150 OR (SELECT count(*) FROM experience.chat_generation_attempts)<>300 THEN RAISE EXCEPTION 'Attempt denominator counted as requests'; END IF;
  IF (SELECT count(*) FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08'))<>2 THEN RAISE EXCEPTION 'Threshold cohorts merged'; END IF;
  FOR row_report IN SELECT * FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08') LOOP
    IF NOT (row_report->>'sample_eligible')::boolean OR (row_report->>'model_requests')::integer<>150 THEN RAISE EXCEPTION '150 sample qualification is not per model'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM miniapp_analytics.chat_first_token_report('2026-10-21 00:00:00+08','2026-10-22 10:00:00+08')) THEN RAISE EXCEPTION 'Exclusive window end counted'; END IF;
  IF (SELECT count(*) FROM experience.chat_generation_requests WHERE client_outcome='timed_out')<>1 THEN RAISE EXCEPTION 'Repeated reports overwrote first observation'; END IF;
  -- Cancellation before delivery closes the same immutable parent/charge identity.
  UPDATE experience.chat_history SET llm_finish_reason='cancelled' WHERE id=h;
  BEGIN
    PERFORM experience.prepare_chat_generation_fallback(h,gen_random_uuid(),4300);
    RAISE EXCEPTION 'Cancelled generation dispatched fallback';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  -- A request exists before prompt/quote/dispatch; preparation failure is not lost.
  h:=gen_random_uuid(); p:=gen_random_uuid(); req:=gen_random_uuid();
  INSERT INTO experience.chat_history(id,model,revision,status) VALUES(h,'preparation-source',0,'streaming');
  PERFORM experience.begin_chat_generation_observation(h,jsonb_build_object('request_id',req,'primary_attempt_id',p,'requested_model_id','preparation-only','provider','openrouter','model','preparation-source','received_at','2026-10-22 11:00:00+08','timeout_ms',4000,'deadline_ms',6000,'timeout_rate_target',0.01,'catalog_version',1,'mode','regenerate'));
  UPDATE experience.chat_history SET status='stream_interrupted',llm_finish_reason='timeout' WHERE id=h;
  UPDATE experience.chat_generation_requests SET first_token_timeout=true WHERE chat_history_id=h;
  IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.chat_first_token_facts WHERE chat_history_id=h AND primary_end_reason='not_dispatched' AND primary_actual_first_token_ms IS NULL AND server_first_token_timeout) THEN RAISE EXCEPTION 'Prepared failure disappeared or fabricated TTFT'; END IF;
  IF EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=h) THEN RAISE EXCEPTION 'Undispatched request created provider billing metadata'; END IF;
END;
$$;
-- Operator-selected fallback is frozen for this request, including actual attempt and report.
DO $$
DECLARE h uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); v jsonb;
BEGIN
  FOREACH v IN ARRAY ARRAY['{"fallback_model_id":null}'::jsonb,'{"fallback_model_id":"bad"}'::jsonb,'{"fallback_model_id":"vendor/model with spaces"}'::jsonb] LOOP
    BEGIN
      PERFORM admin.validate_model_catalog_first_token(v);
      RAISE EXCEPTION 'Invalid fallback model accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
  PERFORM admin.validate_model_catalog_first_token('{"fallback_model_id":"vendor/configured-flash:free"}');
  INSERT INTO experience.chat_history(id,model,revision,status) VALUES(h,'configured-source',0,'streaming');
  PERFORM experience.begin_chat_generation_observation(h,jsonb_build_object('request_id',req,'primary_attempt_id',p,'requested_model_id','configured-fallback','provider','openrouter','model','configured-source','received_at','2026-10-22 11:00:00+08','timeout_ms',4000,'deadline_ms',6000,'timeout_rate_target',0.01,'catalog_version',9,'mode','send','fallback_model_id','vendor/configured-flash:free'));
  PERFORM experience.prepare_chat_generation_fallback(h,f,4000);
  IF NOT EXISTS(SELECT 1 FROM experience.chat_generation_attempts WHERE id=f AND provider='openrouter' AND provider_model_id='vendor/configured-flash:free') THEN RAISE EXCEPTION 'Configured fallback route was not frozen'; END IF;
  PERFORM experience.observe_chat_generation_attempt(h,jsonb_build_object('id',f,'role','fallback','provider','openrouter','model','vendor/configured-flash:free','generation_id','configured-gen'));
  IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.chat_first_token_facts WHERE chat_history_id=h AND fallback_model_id='vendor/configured-flash:free') THEN RAISE EXCEPTION 'Configured fallback missing from facts'; END IF;
  IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08') report WHERE report->>'model_id'='configured-fallback' AND report->>'fallback_model_id'='vendor/configured-flash:free') THEN RAISE EXCEPTION 'Configured fallback missing from report'; END IF;
END;
$$;
ALTER TABLE experience.chat_history ENABLE ROW LEVEL SECURITY;
SET ROLE service_role;
SELECT count(*) FROM miniapp_analytics.chat_first_token_facts;
SELECT count(*) FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08');
RESET ROLE;
