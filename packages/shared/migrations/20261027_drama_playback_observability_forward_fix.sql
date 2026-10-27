-- domain: miniapp_analytics; diagnostic projections only, never read by playback/billing.
-- Supersedes the original migration, whose production transaction rolled back on cron.job ACL.
-- Self-contained for both rolled-back and previously provisioned installations; original source stays immutable.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE IF NOT EXISTS miniapp_analytics.drama_playback_observations (
  environment text NOT NULL CHECK (environment IN ('test','production')),
  observation_id text NOT NULL CHECK (observation_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  first_seen_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL,
  start_received_at timestamptz,
  slow_received_at timestamptz,
  final_received_at timestamptz,
  imported_at timestamptz,
  source text NOT NULL CHECK (source IN ('live','railway_import')),
  server_release text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostic_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  network_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_hash text,
  slow_detail jsonb,
  final_detail jsonb,
  network_detail jsonb,
  CONSTRAINT drama_playback_observations_pk PRIMARY KEY (environment,observation_id)
);
COMMENT ON TABLE miniapp_analytics.drama_playback_observations IS
  'Client-reported startup diagnostics, not authoritative user/business facts. One observation per environment. Summary 14d, details 7d. No business FK.';
CREATE INDEX IF NOT EXISTS drama_playback_observations_time_idx
  ON miniapp_analytics.drama_playback_observations (first_seen_at);
ALTER TABLE miniapp_analytics.drama_playback_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_analytics.drama_playback_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON miniapp_analytics.drama_playback_observations TO service_role;
GRANT USAGE ON SCHEMA miniapp_analytics TO service_role;

CREATE OR REPLACE FUNCTION miniapp_analytics.record_drama_playback_observation(
  p_environment text, p_report jsonb, p_server_release text,
  p_received_at timestamptz DEFAULT NULL, p_source text DEFAULT 'live'
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, miniapp_analytics
SET statement_timeout = '1s'
SET lock_timeout = '250ms'
AS $fn$
DECLARE
  v_id text := p_report->>'id';
  v_phase text := p_report->>'phase';
  v_at timestamptz := COALESCE(p_received_at, clock_timestamp());
  v_row miniapp_analytics.drama_playback_observations%ROWTYPE;
  v_network jsonb;
  v_detail boolean;
BEGIN
  IF p_environment NOT IN ('test','production') OR p_source NOT IN ('live','railway_import')
    OR p_report->>'type' IS DISTINCT FROM 'playback'
    OR v_id IS NULL OR v_id !~ '^[a-zA-Z0-9_-]{1,128}$'
    OR v_phase IS NULL OR v_phase NOT IN ('start','slow','final','network')
    OR octet_length(p_report::text)>65536
    OR p_server_release IS NULL OR p_server_release !~ '^[a-zA-Z0-9_.-]{1,128}$'
    OR (v_phase IN ('start','network') AND p_report->>'version' IS DISTINCT FROM '2')
    OR (p_source='live' AND p_received_at IS NOT NULL)
    OR v_at < clock_timestamp()-interval '14 days' OR v_at > clock_timestamp()+interval '5 minutes'
  THEN RAISE EXCEPTION 'invalid drama timing input'; END IF;

  INSERT INTO miniapp_analytics.drama_playback_observations
    (environment,observation_id,first_seen_at,last_received_at,source,server_release,imported_at)
  VALUES (p_environment,v_id,v_at,v_at,p_source,p_server_release,
    CASE WHEN p_source='railway_import' THEN clock_timestamp() END)
  ON CONFLICT (environment,observation_id) DO NOTHING;
  -- Row locking is inside the single RPC, including concurrent first inserts and late reports.
  SELECT * INTO STRICT v_row FROM miniapp_analytics.drama_playback_observations
    WHERE environment=p_environment AND observation_id=v_id FOR UPDATE;
  IF v_phase='final' AND v_row.final_received_at IS NOT NULL THEN
    RETURN CASE WHEN v_row.final_hash=md5(p_report::text) THEN 'duplicate' ELSE 'conflict' END;
  END IF;
  v_row.first_seen_at := LEAST(v_row.first_seen_at,v_at);
  v_row.last_received_at := GREATEST(v_row.last_received_at,v_at);
  IF p_source='live' THEN v_row.source := 'live'; END IF;
  IF p_source='railway_import' THEN v_row.imported_at := COALESCE(v_row.imported_at,clock_timestamp()); END IF;
  IF v_phase='start' THEN v_row.start_received_at := LEAST(v_row.start_received_at,v_at); END IF;
  IF v_phase='slow' THEN v_row.slow_received_at := LEAST(v_row.slow_received_at,v_at); END IF;
  IF v_row.final_received_at IS NULL AND v_phase IN ('start','slow','final') THEN
    -- A late start must not replace a more advanced slow snapshot.
    IF v_phase<>'start' OR v_row.summary='{}'::jsonb THEN
      v_row.summary := p_report - ARRAY['media','queries','diagnostics'];
      v_row.server_release := p_server_release;
    END IF;
  END IF;
  IF v_phase='final' THEN
    v_row.final_received_at := v_at;
    v_row.final_hash := md5(p_report::text);
  END IF;
  IF p_report ? 'diagnostics' AND (v_phase='network' OR v_phase='final' OR v_row.final_received_at IS NULL) THEN
    -- A network supplement may only add network facts, never replace frame/terminal facts.
    IF v_phase<>'network' THEN
      v_row.diagnostic_summary := COALESCE(p_report->'diagnostics','{}'::jsonb)-'network';
    END IF;
    IF p_report#>'{diagnostics,network}' IS NOT NULL THEN
      IF jsonb_array_length(COALESCE(p_report#>'{diagnostics,network,entries}','[]'::jsonb))>16 THEN
        RAISE EXCEPTION 'too many drama media requests';
      END IF;
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'status',p_report#>>'{diagnostics,network,status}',
        'count',count(*),
        'detailed_count',count(*) FILTER (WHERE e->>'visibility'='detailed'),
        'first_ttfb_ms',(array_agg((e->>'ttfbMs')::double precision ORDER BY (e->>'startMs')::double precision)
          FILTER (WHERE e ? 'ttfbMs'))[1],
        'max_ttfb_ms',max((e->>'ttfbMs')::double precision),
        'max_connect_ms',max((e->>'connectMs')::double precision),
        'truncated',p_report#>'{diagnostics,network,truncated}',
        'closed',p_report#>'{diagnostics,network,closed}'
      )) INTO v_network
      FROM jsonb_array_elements(COALESCE(p_report#>'{diagnostics,network,entries}','[]'::jsonb)) e;
      v_row.network_summary := v_network;
    END IF;
  END IF;
  -- Deterministic 5% controls only detailed storage. All summary/quantile samples remain full.
  v_detail := v_row.slow_received_at IS NOT NULL
    OR COALESCE((v_row.summary->>'elapsedMs')::double precision,0)>=10000
    OR (v_row.final_received_at IS NOT NULL AND v_row.summary->>'outcome'<>'playing')
    OR mod(('x'||substr(md5(v_id),1,8))::bit(32)::bigint,20)=0;
  IF v_detail AND v_row.first_seen_at>=clock_timestamp()-interval '7 days' THEN
    IF v_phase='slow' AND v_row.slow_detail IS NULL THEN v_row.slow_detail:=p_report; END IF;
    IF v_phase='final' THEN v_row.final_detail:=p_report; END IF;
    IF v_phase='network' THEN v_row.network_detail:=p_report->'diagnostics'; END IF;
  END IF;
  UPDATE miniapp_analytics.drama_playback_observations SET
    first_seen_at=v_row.first_seen_at,last_received_at=v_row.last_received_at,
    start_received_at=v_row.start_received_at,slow_received_at=v_row.slow_received_at,
    final_received_at=v_row.final_received_at,imported_at=v_row.imported_at,source=v_row.source,
    server_release=v_row.server_release,summary=v_row.summary,diagnostic_summary=v_row.diagnostic_summary,
    network_summary=v_row.network_summary,final_hash=v_row.final_hash,
    slow_detail=v_row.slow_detail,final_detail=v_row.final_detail,network_detail=v_row.network_detail
  WHERE environment=p_environment AND observation_id=v_id;
  RETURN 'stored';
END
$fn$;
REVOKE ALL ON FUNCTION miniapp_analytics.record_drama_playback_observation(text,jsonb,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION miniapp_analytics.record_drama_playback_observation(text,jsonb,text,timestamptz,text) TO service_role;

CREATE OR REPLACE VIEW miniapp_analytics.drama_playback_facts WITH (security_invoker=true) AS
WITH base AS (
  SELECT o.environment,o.observation_id,o.first_seen_at,o.last_received_at,o.start_received_at,
    o.slow_received_at,o.final_received_at,o.imported_at,o.source,o.server_release,o.summary,
    o.diagnostic_summary,o.network_summary,o.final_hash,o.slow_detail,o.final_detail,o.network_detail,
    COALESCE((summary->>'version')::integer,1) AS measurement_version,
    summary->>'entry' AS entry,
    summary->>'videoId' AS video_id,
    COALESCE(summary#>>'{context,release}','unknown') AS client_release,
    COALESCE(summary#>>'{context,platform}','unknown') AS platform,
    summary#>>'{context,sessionId}' AS session_id,
    summary->>'addressSource' AS address_source,
    summary->>'frameMethod' AS frame_method,
    CASE WHEN final_received_at IS NULL THEN 'unknown' ELSE summary->>'outcome' END AS outcome,
    (summary->>'elapsedMs')::double precision AS elapsed_ms,
    (summary#>>'{marks,source_set}')::double precision AS source_ms,
    (summary#>>'{marks,metadata}')::double precision AS metadata_ms,
    (summary#>>'{marks,loadeddata}')::double precision AS loadeddata_ms,
    (summary#>>'{marks,first_frame}')::double precision AS frame_ms,
    (summary#>>'{marks,playing}')::double precision AS playing_ms
  FROM miniapp_analytics.drama_playback_observations o
)
SELECT environment,observation_id,first_seen_at,last_received_at,start_received_at,slow_received_at,
  final_received_at,imported_at,source,measurement_version,server_release,client_release,platform,
  session_id,entry,video_id,address_source,frame_method,outcome,elapsed_ms,
  source_ms AS entry_to_source_ms,
  CASE WHEN metadata_ms>=source_ms THEN metadata_ms-source_ms END AS source_to_metadata_ms,
  CASE WHEN frame_ms>=metadata_ms THEN frame_ms-metadata_ms END AS metadata_to_frame_ms,
  CASE WHEN loadeddata_ms>=metadata_ms THEN loadeddata_ms-metadata_ms END AS metadata_to_data_ms,
  CASE WHEN frame_ms>=loadeddata_ms THEN frame_ms-loadeddata_ms END AS data_to_frame_ms,
  frame_ms AS first_frame_ms,
  CASE WHEN frame_ms IS NOT NULL AND playing_ms IS NOT NULL THEN greatest(frame_ms,playing_ms) END AS startup_ms,
  CASE WHEN frame_ms IS NOT NULL AND playing_ms IS NOT NULL THEN greatest(frame_ms,playing_ms)-frame_ms END AS frame_to_startup_ms,
  (network_summary->>'first_ttfb_ms')::double precision AS first_ttfb_ms,
  (network_summary->>'max_ttfb_ms')::double precision AS max_ttfb_ms,
  (network_summary->>'max_connect_ms')::double precision AS max_connect_ms,
  COALESCE(network_summary->>'status','unknown') AS network_status,
  (diagnostic_summary#>>'{frame,processingMs}')::double precision AS frame_processing_ms,
  CASE WHEN diagnostic_summary#>>'{longTasks,support}'='supported'
    THEN (diagnostic_summary#>>'{longTasks,metadataToFrameMs}')::double precision END AS metadata_frame_longtask_ms,
  (COALESCE(metadata_ms<source_ms,false) OR COALESCE(loadeddata_ms<metadata_ms,false)
    OR COALESCE(frame_ms<loadeddata_ms,false)) AS event_order_anomaly,
  summary,diagnostic_summary,network_summary,slow_detail,final_detail,network_detail
FROM base;
REVOKE ALL ON miniapp_analytics.drama_playback_facts FROM PUBLIC,anon,authenticated;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drama_metrics_reader') THEN
    CREATE ROLE drama_metrics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drama_metrics_reader' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Unexpected drama reader privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='grafana_cloud' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Unexpected Grafana login privileges';
  END IF;
END
$roles$;
GRANT USAGE ON SCHEMA miniapp_analytics TO drama_metrics_reader;
REVOKE ALL ON miniapp_analytics.drama_playback_observations FROM drama_metrics_reader;
GRANT SELECT (environment,observation_id,first_seen_at,last_received_at,start_received_at,
  slow_received_at,final_received_at,imported_at,source,server_release,summary,diagnostic_summary,
  network_summary,final_hash,slow_detail,final_detail,network_detail)
  ON miniapp_analytics.drama_playback_observations TO drama_metrics_reader;
GRANT SELECT ON miniapp_analytics.drama_playback_facts TO drama_metrics_reader;
DROP POLICY IF EXISTS drama_metrics_read ON miniapp_analytics.drama_playback_observations;
CREATE POLICY drama_metrics_read ON miniapp_analytics.drama_playback_observations FOR SELECT TO drama_metrics_reader USING (true);
DO $membership$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='grafana_cloud') THEN
    GRANT drama_metrics_reader TO grafana_cloud WITH INHERIT TRUE, SET FALSE;
  END IF;
END
$membership$;

CREATE OR REPLACE FUNCTION miniapp_analytics.cleanup_drama_playback_observations(p_limit integer DEFAULT 10000)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,miniapp_analytics
SET statement_timeout='5s' SET lock_timeout='250ms'
AS $cleanup$
DECLARE v_rows integer; v_details integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10000 THEN RAISE EXCEPTION 'invalid cleanup limit'; END IF;
  DELETE FROM miniapp_analytics.drama_playback_observations WHERE ctid IN (
    SELECT ctid FROM miniapp_analytics.drama_playback_observations WHERE first_seen_at<now()-interval '14 days'
    ORDER BY first_seen_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  UPDATE miniapp_analytics.drama_playback_observations SET slow_detail=NULL,final_detail=NULL,network_detail=NULL
  WHERE ctid IN (
    SELECT ctid FROM miniapp_analytics.drama_playback_observations
    WHERE first_seen_at<now()-interval '7 days' AND (slow_detail IS NOT NULL OR final_detail IS NOT NULL OR network_detail IS NOT NULL)
    ORDER BY first_seen_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_details=ROW_COUNT;
  RETURN jsonb_build_object('deleted',v_rows,'details_cleared',v_details);
END
$cleanup$;
REVOKE ALL ON FUNCTION miniapp_analytics.cleanup_drama_playback_observations(integer) FROM PUBLIC,anon,authenticated,service_role;
-- The owner-only job starts disabled. Enable only after TEST/production capacity checks.
DO $cron$
DECLARE v_id bigint;
BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='drama_metrics_cleanup_daily') THEN
      SELECT cron.schedule('drama_metrics_cleanup_daily','15 19 * * *',
        $job$SET statement_timeout='5s'; SET lock_timeout='250ms'; SELECT miniapp_analytics.cleanup_drama_playback_observations(10000);$job$) INTO v_id;
      PERFORM cron.alter_job(job_id := v_id, active := false);
    END IF;
  END IF;
END
$cron$;
COMMIT;

-- Recovery: disable DRAMA_TIMING_PERSIST_ENABLED, keep Pino diagnostics; disable the cleanup job;
-- REVOKE drama_metrics_reader FROM grafana_cloud. Preserve the table; no business data rollback.
