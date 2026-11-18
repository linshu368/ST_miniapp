-- domain: media_plaza
-- Expand only. Run on TEST through Database Migration before the Stream application.
-- Rollback: stop workers; retain jobs/assets and forward-fix (never redeploy MP4 writers).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE media_plaza.video_artifacts
  ADD COLUMN stream_uid TEXT CONSTRAINT video_artifacts_stream_uid_check CHECK (stream_uid ~ '^[a-f0-9]{32}$'),
  ADD COLUMN playback_url TEXT CONSTRAINT video_artifacts_playback_url_check
    CHECK (playback_url ~ '^https://customer-[a-zA-Z0-9-]+[.]cloudflarestream[.]com/[a-f0-9]{32}/manifest/video[.]m3u8$');
ALTER TABLE media_plaza.video_artifacts ALTER COLUMN storage_path DROP NOT NULL;
ALTER TABLE media_plaza.video_artifacts ADD CONSTRAINT video_artifacts_stream_shape CHECK (
  (stream_uid IS NULL AND playback_url IS NULL) OR
  (stream_uid IS NOT NULL AND playback_url IS NOT NULL AND playback_url LIKE '%/' || stream_uid || '/manifest/video.m3u8')
);
CREATE UNIQUE INDEX video_artifacts_stream_uid_unique ON media_plaza.video_artifacts(stream_uid);

CREATE TABLE media_plaza.video_delivery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL CONSTRAINT video_delivery_jobs_attempt_unique UNIQUE
    REFERENCES media_plaza.video_attempts(id) ON DELETE RESTRICT,
  artifact_id UUID REFERENCES media_plaza.video_artifacts(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL DEFAULT 'queued' CONSTRAINT video_delivery_jobs_stage_check
    CHECK (stage IN ('queued','creating','uploading','encoding','completed','failed','unknown')),
  stream_uid TEXT CONSTRAINT video_delivery_jobs_uid_check CHECK (stream_uid ~ '^[a-f0-9]{32}$'),
  upload_url TEXT,
  source_sha256 TEXT CONSTRAINT video_delivery_jobs_hash_check CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size BIGINT CONSTRAINT video_delivery_jobs_size_check CHECK (source_byte_size BETWEEN 1 AND 209715200),
  retry_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT video_delivery_jobs_retry_check CHECK (retry_count >= 0),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '20 minutes',
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_delivery_jobs_upload_shape CHECK
    (stage <> 'uploading' OR (stream_uid IS NOT NULL AND upload_url IS NOT NULL AND source_sha256 IS NOT NULL AND source_byte_size IS NOT NULL)),
  CONSTRAINT video_delivery_jobs_terminal_capability CHECK
    (stage NOT IN ('completed','failed') OR upload_url IS NULL)
);
COMMENT ON TABLE media_plaza.video_delivery_jobs IS
  'J: fenced Stream delivery owned by image-plaza worker. Same-domain attempt/artifact references; service only. No billing/observation facts. Completed/failed retained 7 days, unknown until reconciliation. Upload capability is secret and cleared at terminal state. Recovery reuses the same UID, never resubmits generation.';
COMMENT ON COLUMN media_plaza.video_artifacts.stream_uid IS 'Stable private Stream asset identity; signed playback tokens are never persisted.';
COMMENT ON COLUMN media_plaza.video_artifacts.playback_url IS 'Stable unsigned HLS reference, not a public access grant.';
ALTER TABLE media_plaza.video_delivery_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON media_plaza.video_delivery_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON media_plaza.video_delivery_jobs TO service_role;
CREATE INDEX video_delivery_jobs_runnable_idx ON media_plaza.video_delivery_jobs(next_run_at)
  WHERE stage IN ('queued','creating','uploading','encoding');

CREATE FUNCTION media_plaza.enqueue_video_delivery(p_attempt_id UUID, p_worker_id TEXT, p_download_url TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_attempt media_plaza.video_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM media_plaza.video_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF v_attempt.status='storing' AND EXISTS(SELECT 1 FROM media_plaza.video_delivery_jobs WHERE attempt_id=p_attempt_id) THEN RETURN; END IF;
  IF v_attempt.status NOT IN ('queued','processing') OR v_attempt.lease_owner IS DISTINCT FROM p_worker_id
     OR v_attempt.lease_expires_at IS NULL OR v_attempt.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'video generation lease lost' USING ERRCODE='55000';
  END IF;
  INSERT INTO media_plaza.video_delivery_jobs(attempt_id) VALUES(p_attempt_id);
  UPDATE media_plaza.video_attempts SET status='storing', download_url=p_download_url,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=p_attempt_id;
END $$;

CREATE FUNCTION media_plaza.claim_video_delivery_jobs(p_limit INTEGER DEFAULT 2)
RETURNS SETOF media_plaza.video_delivery_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  RETURN QUERY WITH candidates AS (
    SELECT id FROM media_plaza.video_delivery_jobs
    WHERE stage IN ('queued','creating','uploading','encoding') AND next_run_at<=now()
      AND (lease_expires_at IS NULL OR lease_expires_at<=now())
    ORDER BY next_run_at,id LIMIT LEAST(GREATEST(p_limit,1),4) FOR UPDATE SKIP LOCKED
  ) UPDATE media_plaza.video_delivery_jobs j SET lease_token=gen_random_uuid(),
      lease_expires_at=now()+interval '5 minutes',updated_at=now()
    FROM candidates c WHERE j.id=c.id RETURNING j.*;
END $$;

DROP FUNCTION media_plaza.publish_video_artifact(UUID,TEXT,TEXT,BIGINT,INTEGER,INTEGER,INTEGER,TEXT,INTEGER,INTEGER);
CREATE FUNCTION media_plaza.publish_video_artifact(
  p_attempt_id UUID,p_lease_token UUID,p_stream_uid TEXT,p_playback_url TEXT,p_byte_size BIGINT,
  p_width INTEGER,p_height INTEGER,p_duration_ms INTEGER,p_poster_path TEXT,p_poster_width INTEGER,p_poster_height INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a media_plaza.video_attempts%ROWTYPE; j media_plaza.video_delivery_jobs%ROWTYPE; v_id UUID;
BEGIN
  -- Every delivery mutation locks attempt before job: refund and publish share this order.
  SELECT * INTO a FROM media_plaza.video_attempts WHERE id=p_attempt_id FOR UPDATE;
  SELECT * INTO j FROM media_plaza.video_delivery_jobs WHERE attempt_id=p_attempt_id FOR UPDATE;
  IF a.status='ready' AND j.stage='completed' THEN RETURN jsonb_build_object('artifact_id',j.artifact_id,'already_published',true); END IF;
  IF a.status IS DISTINCT FROM 'storing' OR a.refund_ledger_id IS NOT NULL OR a.debit_ledger_id IS NULL
    OR j.stage IS DISTINCT FROM 'encoding' OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_expires_at IS NULL OR j.lease_expires_at<=now() OR j.stream_uid IS DISTINCT FROM p_stream_uid OR j.source_byte_size IS DISTINCT FROM p_byte_size THEN
    RAISE EXCEPTION 'video delivery lease lost' USING ERRCODE='55000';
  END IF;
  INSERT INTO media_plaza.video_artifacts(attempt_id,origin,stream_uid,playback_url,byte_size,width,height,duration_ms,
    poster_path,poster_width,poster_height)
  VALUES(p_attempt_id,'generated',p_stream_uid,p_playback_url,p_byte_size,p_width,p_height,p_duration_ms,
    p_poster_path,p_poster_width,p_poster_height) RETURNING id INTO v_id;
  UPDATE media_plaza.video_attempts SET status='ready',download_url=NULL,completed_at=now(),updated_at=now() WHERE id=p_attempt_id;
  UPDATE media_plaza.video_delivery_jobs SET stage='completed',artifact_id=v_id,upload_url=NULL,
    lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('artifact_id',v_id,'already_published',false);
END $$;

CREATE FUNCTION media_plaza.fail_video_delivery(p_attempt_id UUID,p_lease_token UUID,p_error_code TEXT,p_unknown BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a media_plaza.video_attempts%ROWTYPE; j media_plaza.video_delivery_jobs%ROWTYPE;
BEGIN
  SELECT * INTO a FROM media_plaza.video_attempts WHERE id=p_attempt_id FOR UPDATE;
  SELECT * INTO j FROM media_plaza.video_delivery_jobs WHERE attempt_id=p_attempt_id FOR UPDATE;
  IF j.stage IN ('completed','failed','unknown') THEN RETURN; END IF;
  IF a.status IS DISTINCT FROM 'storing' OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_expires_at IS NULL OR j.lease_expires_at<=now() THEN
    RAISE EXCEPTION 'video delivery lease lost' USING ERRCODE='55000';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,120}$' THEN RAISE EXCEPTION 'invalid error code'; END IF;
  UPDATE media_plaza.video_attempts SET status=CASE WHEN p_unknown THEN 'failed_unknown' ELSE 'failed' END,
    error_code=p_error_code,completed_at=now(),updated_at=now() WHERE id=p_attempt_id;
  IF NOT p_unknown THEN PERFORM billing.refund_media_plaza_video(p_attempt_id,p_error_code); END IF;
  UPDATE media_plaza.video_delivery_jobs SET stage=CASE WHEN p_unknown THEN 'unknown' ELSE 'failed' END,
    upload_url=CASE WHEN p_unknown THEN upload_url ELSE NULL END,error_code=p_error_code,
    lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=j.id;
END $$;

REVOKE ALL ON FUNCTION media_plaza.enqueue_video_delivery(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION media_plaza.claim_video_delivery_jobs(INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION media_plaza.publish_video_artifact(UUID,UUID,TEXT,TEXT,BIGINT,INTEGER,INTEGER,INTEGER,TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION media_plaza.fail_video_delivery(UUID,UUID,TEXT,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION media_plaza.enqueue_video_delivery(UUID,TEXT,TEXT),
  media_plaza.claim_video_delivery_jobs(INTEGER),
  media_plaza.publish_video_artifact(UUID,UUID,TEXT,TEXT,BIGINT,INTEGER,INTEGER,INTEGER,TEXT,INTEGER,INTEGER),
  media_plaza.fail_video_delivery(UUID,UUID,TEXT,BOOLEAN) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
