-- Local synthetic PG test. No remote application data or wallets.
DO $$
DECLARE d date := (now() AT TIME ZONE 'Asia/Shanghai')::date; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 h1 uuid:=gen_random_uuid();h2 uuid:=gen_random_uuid();h3 uuid:=gen_random_uuid();h4 uuid:=gen_random_uuid();
 charge1 uuid:=gen_random_uuid();charge2 uuid:=gen_random_uuid();r record;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname LIKE 'grafana_cache_%')<>0
 OR NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='unrelated_job')
 OR NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='grafana_core_recent_30m' AND NOT active
 AND command LIKE '%statement_timeout=''5s''%' AND command LIKE '%max_parallel_workers_per_gather=0%')
 THEN RAISE EXCEPTION 'Cron retirement or bounded activation failed';END IF;
 INSERT INTO experience.chat_history VALUES
 (h1,a,d::timestamp AT TIME ZONE 'Asia/Shanghai',charge1,'actual-fallback','success','{"model_id":"selected-A","model_display_name":"Original A"}'),
 (h2,a,(d::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '1h',charge2,'B','success','{"model_id":"selected-B"}'),
 (h3,b,(d::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '2h',NULL,'A','upstream_error','{"model_id":"selected-A"}'),
 (h4,b,(d::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '3h',NULL,'rejected','insufficient_balance',NULL),
 (gen_random_uuid(),b,(d::timestamp AT TIME ZONE 'Asia/Shanghai')-interval '1ms',NULL,'yesterday','success',NULL);
 INSERT INTO billing.llm_usage_charges VALUES(charge1,'selected-A','Original A','charged',15,NULL),
 (charge2,'selected-B','Original B','free',0,0);
 INSERT INTO experience.openrouter_chat_history VALUES(h1,'0.005');
 INSERT INTO billing.payment_orders VALUES(a,'completed',(d::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '1h',1234),
 (b,'pending',(d::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '1h',9999);
 PERFORM miniapp_analytics.refresh_grafana_core_day(d);
 SELECT * INTO STRICT r FROM miniapp_analytics.grafana_core_daily WHERE metric_date=d AND metric_scope='overall';
 IF r.requests<>3 OR r.chat_users<>2 OR r.charged_requests<>1 OR r.charged_stars<>15
 OR r.known_cost_requests<>2 OR r.recorded_cost_usd<>0.005 OR r.paid_orders<>1 OR r.cash_cny<>12.34
 THEN RAISE EXCEPTION 'Exact counts, distinct users, missing/zero cost, payment or stars changed: %',row_to_json(r); END IF;
 IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.grafana_core_daily WHERE metric_scope='model'
 AND model_id='selected-A' AND requests=2 AND chat_users=2 AND paid_orders IS NULL)
 OR EXISTS(SELECT 1 FROM miniapp_analytics.grafana_core_daily WHERE model_id='actual-fallback')
 THEN RAISE EXCEPTION 'Requested-model attribution or scope changed';END IF;
 PERFORM miniapp_analytics.refresh_grafana_core_day(d);
 IF (SELECT count(*) FROM miniapp_analytics.grafana_core_daily WHERE metric_date=d)<>3 THEN RAISE EXCEPTION 'Non-idempotent day';END IF;
 PERFORM miniapp_analytics.refresh_grafana_core_day(d-1);
 IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.grafana_core_daily WHERE metric_date=d-1 AND metric_scope='overall' AND requests=1 AND recorded_cost_usd IS NULL)
 THEN RAISE EXCEPTION 'Beijing date boundary or missing cost changed';END IF;
 PERFORM miniapp_analytics.refresh_grafana_core_day(d-2);
 IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.grafana_core_daily WHERE metric_date=d-2 AND metric_scope='overall' AND requests=0 AND recorded_cost_usd IS NULL)
 THEN RAISE EXCEPTION 'Empty day masquerades as known zero cost';END IF;
 BEGIN PERFORM miniapp_analytics.refresh_grafana_core_day(d-14);RAISE EXCEPTION 'unbounded day accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='unbounded day accepted' THEN RAISE;END IF; END;
 IF has_function_privilege('anon','miniapp_analytics.refresh_grafana_core_day(date)','EXECUTE')
 OR has_function_privilege('first_token_metrics_reader','miniapp_analytics.refresh_grafana_core_day(date)','EXECUTE')
 OR has_table_privilege('anon','miniapp_analytics.grafana_core_daily','SELECT')
 THEN RAISE EXCEPTION 'Reporting privilege broadened';END IF;
END $$;
CREATE FUNCTION miniapp_analytics.test_fail_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'synthetic refresh failure';END $$;
CREATE TRIGGER test_fail BEFORE INSERT ON miniapp_analytics.grafana_core_daily
 FOR EACH ROW EXECUTE FUNCTION miniapp_analytics.test_fail_refresh();
DO $$ DECLARE n bigint;BEGIN
 SELECT count(*) INTO n FROM miniapp_analytics.grafana_core_daily;
 BEGIN PERFORM miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date);
 EXCEPTION WHEN raise_exception THEN NULL;END;
 IF (SELECT count(*) FROM miniapp_analytics.grafana_core_daily)<>n THEN RAISE EXCEPTION 'Failure erased last snapshot';END IF;
END $$;
DROP TRIGGER test_fail ON miniapp_analytics.grafana_core_daily;
SET ROLE first_token_metrics_reader;
SELECT count(*) FROM miniapp_analytics.grafana_core_daily;
DO $$ BEGIN
 BEGIN DELETE FROM miniapp_analytics.grafana_core_daily;RAISE EXCEPTION 'Reader can write';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM user_id FROM experience.chat_history;RAISE EXCEPTION 'Reader can read users';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
RESET ROLE;
