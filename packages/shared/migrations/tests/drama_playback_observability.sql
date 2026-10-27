\set ON_ERROR_STOP on
SET ROLE service_role;
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"slow-case","phase":"slow","elapsedMs":10000,"outcome":"waiting","marks":{"source_set":100,"metadata":8000}}','test');
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"slow-case","phase":"final","elapsedMs":45000,"outcome":"playing","marks":{"source_set":100,"metadata":8000,"loadeddata":44000,"first_frame":44500,"playing":45000}}','test');
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","version":2,"id":"slow-case","phase":"start","elapsedMs":0,"outcome":"waiting","marks":{}}','test');
DO $$
DECLARE v_result text;
BEGIN
 SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"slow-case","phase":"final","elapsedMs":45000,"outcome":"playing","marks":{"source_set":100,"metadata":8000,"loadeddata":44000,"first_frame":44500,"playing":45000}}','test') INTO v_result;
 IF v_result<>'duplicate' THEN RAISE EXCEPTION 'duplicate final failed'; END IF;
 SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"slow-case","phase":"final","elapsedMs":1,"outcome":"error","marks":{}}','test') INTO v_result;
 IF v_result<>'conflict' THEN RAISE EXCEPTION 'conflict final failed'; END IF;
END $$;
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","version":2,"id":"slow-case","phase":"network","elapsedMs":45000,"outcome":"playing","marks":{},"diagnostics":{"network":{"status":"available","entries":[{"startMs":100,"visibility":"detailed","ttfbMs":7000,"connectMs":100}],"truncated":false}}}','test');
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"zero-case","phase":"final","elapsedMs":0,"outcome":"playing","marks":{"source_set":0,"metadata":0,"loadeddata":0,"first_frame":0,"playing":0}}','test');
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"incomplete","phase":"slow","elapsedMs":10000,"outcome":"waiting","marks":{"source_set":1}}','test');
SELECT miniapp_analytics.record_drama_playback_observation('test',
 '{"type":"playback","id":"inverted","phase":"final","elapsedMs":100,"outcome":"playing","marks":{"metadata":10,"loadeddata":90,"first_frame":80,"playing":100}}','test');
RESET ROLE;
DO $$
DECLARE r record;
BEGIN
 SELECT * INTO STRICT r FROM miniapp_analytics.drama_playback_facts WHERE observation_id='slow-case';
 IF r.outcome<>'playing' OR r.startup_ms<>45000 OR r.first_frame_ms<>44500
   OR r.source_to_metadata_ms<>7900 OR r.metadata_to_data_ms<>36000 OR r.data_to_frame_ms<>500
   OR r.frame_to_startup_ms<>500 OR r.max_ttfb_ms<>7000 OR r.start_received_at IS NULL
   OR r.slow_detail IS NULL OR r.final_detail IS NULL THEN RAISE EXCEPTION 'stage/merge/retention mismatch'; END IF;
 IF (SELECT count(*) FROM miniapp_analytics.drama_playback_observations WHERE observation_id='slow-case')<>1 THEN RAISE EXCEPTION 'sample duplication'; END IF;
 IF (SELECT startup_ms FROM miniapp_analytics.drama_playback_facts WHERE observation_id='zero-case')<>0 THEN RAISE EXCEPTION 'zero lost'; END IF;
 IF (SELECT outcome FROM miniapp_analytics.drama_playback_facts WHERE observation_id='incomplete')<>'unknown'
   OR (SELECT startup_ms FROM miniapp_analytics.drama_playback_facts WHERE observation_id='incomplete') IS NOT NULL THEN RAISE EXCEPTION 'incomplete fabricated'; END IF;
 IF (SELECT data_to_frame_ms FROM miniapp_analytics.drama_playback_facts WHERE observation_id='inverted') IS NOT NULL
   OR NOT (SELECT event_order_anomaly FROM miniapp_analytics.drama_playback_facts WHERE observation_id='inverted') THEN RAISE EXCEPTION 'negative stage fabricated'; END IF;
END $$;
SET ROLE drama_metrics_reader;
SELECT count(*) FROM miniapp_analytics.drama_playback_facts;
DO $$BEGIN
 BEGIN
  PERFORM miniapp_analytics.record_drama_playback_observation('test','{}','test');
  RAISE EXCEPTION 'reader can write';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$BEGIN
 BEGIN
  PERFORM 1 FROM miniapp_analytics.drama_playback_observations;
  RAISE EXCEPTION 'anon can read';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
INSERT INTO miniapp_analytics.drama_playback_observations
 (environment,observation_id,first_seen_at,last_received_at,source,server_release,final_detail)
 VALUES ('test','expired',now()-interval '15 days',now(),'live','test','{}'),
 ('test','old-detail',now()-interval '8 days',now(),'live','test','{}');
SELECT miniapp_analytics.cleanup_drama_playback_observations(10000);
DO $$BEGIN
 IF EXISTS (SELECT 1 FROM miniapp_analytics.drama_playback_observations WHERE observation_id='expired')
 OR EXISTS (SELECT 1 FROM miniapp_analytics.drama_playback_observations WHERE observation_id='old-detail' AND final_detail IS NOT NULL)
 THEN RAISE EXCEPTION 'retention failed'; END IF;
END $$;
