-- domain: media_plaza + billing
-- Production-compatible bootstrap of the existing video contract. One-shot, atomic.
-- Does not replace the historical migration or move existing legacy M/J fields.
-- Keep workers disabled until Stream delivery and compatible applications are deployed.
-- Lock timeout/unknown result: stop, inspect catalog + claim + ledger; never force a rerun.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('media_plaza.image_plaza_works') IS NULL
     OR to_regclass('media_plaza.image_plaza_messages') IS NULL
     OR to_regclass('billing.image_plaza_share_rewards') IS NULL
     OR to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('billing.refund_wallet_debit(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'media plaza M2 prerequisites are missing';
  END IF;
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('media_plaza.image_plaza_artifacts') IS NULL
     OR to_regclass('media_plaza.image_plaza_conversations') IS NULL
     OR to_regclass('media_plaza.image_plaza_reference_assets') IS NULL THEN
    RAISE EXCEPTION 'video_prod_base: prerequisite objects missing';
  END IF;
  IF to_regclass('media_plaza.video_delivery_jobs') IS NOT NULL
     OR EXISTS (SELECT FROM information_schema.columns
       WHERE (table_schema='media_plaza' AND table_name IN ('image_plaza_works','image_plaza_messages')
         AND column_name IN ('media_type','video_attempt_id','video_artifact_id','source_video_id'))
          OR (table_schema='billing' AND table_name='image_plaza_share_rewards' AND column_name='video_attempt_id'))
     OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE (n.nspname='billing' AND p.proname IN ('reserve_media_plaza_video','refund_media_plaza_video','share_media_plaza_video'))
          OR (n.nspname='media_plaza' AND p.proname IN ('claim_video_submit_jobs','claim_video_poll_jobs','publish_video_artifact','import_video_seed_work'))) THEN
    RAISE EXCEPTION 'video_prod_base: video schema already or partially provisioned';
  END IF;
  IF (SELECT count(*) FROM (SELECT 1 FROM media_plaza.image_plaza_works LIMIT 100001) q)>100000
     OR (SELECT count(*) FROM (SELECT 1 FROM media_plaza.image_plaza_messages LIMIT 100001) q)>100000 THEN
    RAISE EXCEPTION 'video_prod_base: image catalog exceeds reviewed capacity';
  END IF;
  IF EXISTS (SELECT FROM storage.buckets WHERE id='media-plaza-video'
    AND (public OR (allowed_mime_types IS NOT NULL AND NOT ('image/jpeg'=ANY(allowed_mime_types)))
      OR (file_size_limit IS NOT NULL AND file_size_limit<20971520))) THEN
    RAISE EXCEPTION 'video_prod_base: existing cover bucket is incompatible';
  END IF;
  IF to_regclass('media_plaza.video_attempts') IS NOT NULL
     OR to_regclass('media_plaza.video_artifacts') IS NOT NULL
     OR to_regclass('media_plaza.video_quotes') IS NOT NULL THEN
    RAISE EXCEPTION 'media plaza M2 was already applied or partially provisioned';
  END IF;
END;
$$;

CREATE TABLE media_plaza.video_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL CHECK (char_length(trim(model_id)) BETWEEN 1 AND 80),
  provider_model_id TEXT NOT NULL CHECK (char_length(trim(provider_model_id)) BETWEEN 1 AND 160),
  input_mode TEXT NOT NULL CHECK (input_mode IN ('t2v', 'i2v', 'r2v')),
  duration_s INTEGER NOT NULL CHECK (duration_s BETWEEN 1 AND 300),
  resolution TEXT NOT NULL CHECK (char_length(trim(resolution)) BETWEEN 1 AND 24),
  aspect_ratio TEXT CHECK (aspect_ratio IS NULL OR char_length(trim(aspect_ratio)) BETWEEN 1 AND 24),
  audio BOOLEAN NOT NULL,
  credits NUMERIC(14,1) NOT NULL CHECK (credits > 0),
  catalog_version INTEGER NOT NULL CHECK (catalog_version >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE media_plaza.video_quotes IS
  'Authoritative ten-minute video quote. Backend quote route is the sole writer; rows expire and may be pruned. Runtime submit consumes it; depends on app_core.users. Service-only ACL/RLS, bounded by request rate. Recovery is additive/forward-fix.';

CREATE TABLE media_plaza.video_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES media_plaza.image_plaza_conversations(id) ON DELETE CASCADE,
  user_message_id UUID NOT NULL REFERENCES media_plaza.image_plaza_messages(id) ON DELETE RESTRICT,
  assistant_message_id UUID NOT NULL REFERENCES media_plaza.image_plaza_messages(id) ON DELETE RESTRICT,
  quote_id UUID NOT NULL REFERENCES media_plaza.video_quotes(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  prompt TEXT NOT NULL CHECK (char_length(trim(prompt)) >= 1),
  model_id TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  input_mode TEXT NOT NULL CHECK (input_mode IN ('t2v', 'i2v', 'r2v')),
  duration_s INTEGER NOT NULL CHECK (duration_s BETWEEN 1 AND 300),
  resolution TEXT NOT NULL CHECK (char_length(trim(resolution)) BETWEEN 1 AND 24),
  aspect_ratio TEXT CHECK (aspect_ratio IS NULL OR char_length(trim(aspect_ratio)) BETWEEN 1 AND 24),
  audio BOOLEAN NOT NULL,
  reference_artifact_id UUID REFERENCES media_plaza.image_plaza_reference_assets(id) ON DELETE RESTRICT,
  quote_credits NUMERIC(14,1) NOT NULL CHECK (quote_credits > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'submitting', 'queued', 'processing', 'storing', 'ready',
    'failed', 'moderation_rejected', 'expired', 'failed_unknown'
  )),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  provider_request_id TEXT,
  provider_status TEXT,
  download_url TEXT,
  next_poll_at TIMESTAMPTZ,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  error_code TEXT,
  debit_ledger_id UUID REFERENCES billing.wallet_ledger(id) ON DELETE RESTRICT,
  refund_ledger_id UUID REFERENCES billing.wallet_ledger(id) ON DELETE RESTRICT,
  credits_charged NUMERIC(14,1) NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  charged_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_attempts_user_idempotency_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT video_attempts_reference_mode_check CHECK (
    (input_mode = 't2v' AND reference_artifact_id IS NULL)
    OR (input_mode IN ('i2v', 'r2v') AND reference_artifact_id IS NOT NULL)
  ),
  CONSTRAINT video_attempts_charge_shape_check CHECK (
    (debit_ledger_id IS NULL AND credits_charged = 0 AND charged_at IS NULL)
    OR (debit_ledger_id IS NOT NULL AND credits_charged = quote_credits AND charged_at IS NOT NULL)
  ),
  CONSTRAINT video_attempts_refund_shape_check CHECK (
    (refund_ledger_id IS NULL AND refunded_at IS NULL)
    OR (refund_ledger_id IS NOT NULL AND debit_ledger_id IS NOT NULL AND refunded_at IS NOT NULL)
  ),
  CONSTRAINT video_attempts_ready_shape_check CHECK (
    status <> 'ready' OR (debit_ledger_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE media_plaza.video_attempts IS
  'One authoritative video generation state machine. Backend creates; fenced workers transition. Billing facts prevent deletion. Studio/worker consume it; cross-domain users/messages/wallet ledger are explicit. Service-only ACL/RLS. Poll indexes bound scans; provider ambiguity ends failed_unknown. Recover by disabling workers and forward-fix.';

CREATE TABLE media_plaza.video_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID REFERENCES media_plaza.video_attempts(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'civitai_seed')),
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4' CHECK (mime_type = 'video/mp4'),
  byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 209715200),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 16384),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  poster_path TEXT,
  poster_width INTEGER CHECK (poster_width IS NULL OR poster_width BETWEEN 1 AND 16384),
  poster_height INTEGER CHECK (poster_height IS NULL OR poster_height BETWEEN 1 AND 16384),
  source_video_id TEXT,
  source_video_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_artifacts_origin_shape_check CHECK (
    (origin = 'generated' AND attempt_id IS NOT NULL AND source_video_id IS NULL AND source_video_url IS NULL)
    OR
    (origin = 'civitai_seed' AND attempt_id IS NULL AND source_video_id IS NOT NULL AND source_video_url IS NOT NULL)
  ),
  CONSTRAINT video_artifacts_poster_shape_check CHECK (
    (poster_path IS NULL AND poster_width IS NULL AND poster_height IS NULL)
    OR (poster_path IS NOT NULL AND poster_width IS NOT NULL AND poster_height IS NOT NULL)
  ),
  CONSTRAINT video_artifacts_origin_source_unique UNIQUE (origin, source_video_id)
);

COMMENT ON TABLE media_plaza.video_artifacts IS
  'Stored MP4/poster metadata is authoritative for generated and reviewed seed media. Worker/import RPCs write; referenced rows are retained. Detail/feed/share consume it; depends on attempts and private Storage. Service-only ACL/RLS, 200MiB cap, no provider URL is public. Recover by preserving rows and forward-fix.';

ALTER TABLE media_plaza.image_plaza_messages
  ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'
    CHECK (media_type IN ('image', 'video')),
  ADD COLUMN video_attempt_id UUID REFERENCES media_plaza.video_attempts(id) ON DELETE RESTRICT;

ALTER TABLE media_plaza.image_plaza_messages
  ADD CONSTRAINT image_plaza_messages_media_shape_check CHECK (
    (media_type = 'image' AND video_attempt_id IS NULL)
    OR (media_type = 'video' AND video_attempt_id IS NOT NULL)
  ) NOT VALID;

-- Preserve the current image-origin predicate verbatim; only video rows are exempted.
DO $image_shape$
DECLARE
  v_expression TEXT;
  v_comment TEXT;
BEGIN
  SELECT pg_get_expr(conbin,conrelid), obj_description(oid,'pg_constraint')
    INTO v_expression,v_comment FROM pg_constraint
    WHERE conrelid='media_plaza.image_plaza_works'::regclass
      AND conname='image_plaza_works_origin_shape_check' AND contype='c'
      AND convalidated AND conislocal AND NOT connoinherit;
  IF v_expression IS NULL THEN
    RAISE EXCEPTION 'video_prod_base: image origin constraint differs';
  END IF;
  EXECUTE $image_ddl$
ALTER TABLE media_plaza.image_plaza_works
  DROP CONSTRAINT image_plaza_works_origin_shape_check,
  ALTER COLUMN artifact_id DROP NOT NULL,
  ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'
    CHECK (media_type IN ('image', 'video')),
  ADD COLUMN video_artifact_id UUID REFERENCES media_plaza.video_artifacts(id) ON DELETE RESTRICT,
  ADD COLUMN video_attempt_id UUID REFERENCES media_plaza.video_attempts(id) ON DELETE RESTRICT,
  ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN source_video_id TEXT,
  ADD COLUMN source_video_url TEXT,
  ADD CONSTRAINT image_plaza_works_media_shape_check CHECK (
    (media_type = 'image' AND artifact_id IS NOT NULL AND video_artifact_id IS NULL
      AND video_attempt_id IS NULL AND duration_ms IS NULL
      AND source_video_id IS NULL AND source_video_url IS NULL)
    OR
    (media_type = 'video' AND artifact_id IS NULL AND video_artifact_id IS NOT NULL
      AND duration_ms IS NOT NULL
      AND ((origin = 'generated' AND user_id IS NOT NULL AND attempt_id IS NULL
              AND video_attempt_id IS NOT NULL AND source_video_id IS NULL AND source_video_url IS NULL)
        OR (origin = 'civitai_seed' AND user_id IS NULL AND attempt_id IS NULL
              AND video_attempt_id IS NULL AND source_video_id IS NOT NULL
              AND source_video_url IS NOT NULL AND source_heat IS NOT NULL AND source_heat >= 0)))
  );
$image_ddl$;
  EXECUTE format('ALTER TABLE media_plaza.image_plaza_works ADD CONSTRAINT image_plaza_works_image_origin_shape_check CHECK (media_type <> %L OR (%s))', 'image',v_expression);
  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON CONSTRAINT image_plaza_works_image_origin_shape_check ON media_plaza.image_plaza_works IS %L',v_comment);
  END IF;
END;
$image_shape$;

CREATE UNIQUE INDEX image_plaza_works_video_artifact_unique
  ON media_plaza.image_plaza_works(video_artifact_id)
  WHERE video_artifact_id IS NOT NULL;
CREATE UNIQUE INDEX image_plaza_works_video_seed_unique
  ON media_plaza.image_plaza_works(source_video_id)
  WHERE media_type = 'video' AND origin = 'civitai_seed';
CREATE INDEX image_plaza_works_media_feed_idx
  ON media_plaza.image_plaza_works(media_type, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE billing.image_plaza_share_rewards
  ALTER COLUMN attempt_id DROP NOT NULL,
  ADD COLUMN video_attempt_id UUID REFERENCES media_plaza.video_attempts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT image_plaza_share_rewards_attempt_shape_check CHECK (
    (attempt_id IS NOT NULL)::INTEGER + (video_attempt_id IS NOT NULL)::INTEGER = 1
  );

CREATE UNIQUE INDEX image_plaza_share_rewards_video_attempt_unique
  ON billing.image_plaza_share_rewards(video_attempt_id)
  WHERE video_attempt_id IS NOT NULL;

CREATE INDEX video_attempts_submit_claim_idx
  ON media_plaza.video_attempts(created_at, id)
  WHERE status = 'submitting';
CREATE INDEX video_attempts_poll_claim_idx
  ON media_plaza.video_attempts(next_poll_at, created_at, id)
  WHERE status IN ('queued', 'processing');
CREATE INDEX video_attempts_conversation_idx
  ON media_plaza.video_attempts(conversation_id, created_at, id);
CREATE UNIQUE INDEX video_attempts_provider_request_unique
  ON media_plaza.video_attempts(provider_request_id)
  WHERE provider_request_id IS NOT NULL;

ALTER TABLE media_plaza.video_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_plaza.video_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_plaza.video_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON media_plaza.video_quotes, media_plaza.video_attempts, media_plaza.video_artifacts
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON media_plaza.video_quotes, media_plaza.video_attempts, media_plaza.video_artifacts
  TO service_role, postgres;

-- Widen only the existing single-column predicate, retaining future/creator/survey types.
-- Keep its NOT VALID state: adding videos must not scan or revalidate historical money rows.
DO $ledger_types$
DECLARE
  v_expression TEXT;
  v_comment TEXT;
  v_column SMALLINT;
BEGIN
  SELECT attnum INTO v_column FROM pg_attribute
    WHERE attrelid='billing.wallet_ledger'::regclass AND attname='entry_type' AND NOT attisdropped;
  SELECT pg_get_expr(conbin,conrelid),obj_description(oid,'pg_constraint') INTO v_expression,v_comment
    FROM pg_constraint WHERE conrelid='billing.wallet_ledger'::regclass
      AND conname='wallet_ledger_entry_type_check' AND contype='c'
      AND conkey=ARRAY[v_column] AND NOT convalidated AND conislocal AND NOT connoinherit;
  IF v_expression IS NULL THEN
    RAISE EXCEPTION 'video_prod_base: wallet type constraint differs';
  END IF;
  ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
  EXECUTE format('ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK ((%s) OR entry_type IN (%L,%L)) NOT VALID',v_expression,'media_plaza_video_reserve','media_plaza_video_refund');
  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON CONSTRAINT wallet_ledger_entry_type_check ON billing.wallet_ledger IS %L',v_comment);
  END IF;
END;
$ledger_types$;

CREATE UNIQUE INDEX media_plaza_video_reserve_ledger_unique
  ON billing.wallet_ledger(reference_id)
  WHERE reference_type = 'media_plaza_video_reserve';
CREATE UNIQUE INDEX media_plaza_video_refund_ledger_unique
  ON billing.wallet_ledger(reference_id)
  WHERE reference_type = 'media_plaza_video_refund';

-- Preserve the current wallet body and privileges; patch only the known video guard.
DO $guard$
DECLARE
  v_oid OID := to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)');
  v_before RECORD;
  v_after RECORD;
  v_definition TEXT;
  v_expected_body TEXT;
  v_old CONSTANT TEXT := $old$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation') THEN$old$;
  v_new CONSTANT TEXT := $new$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN$new$;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'video_wallet_guard: wallet debit function missing';
  END IF;
  SELECT proowner, proacl, proconfig, prosecdef, provolatile, proparallel,
    proisstrict, proleakproof, procost, prorows, prosrc
  INTO v_before FROM pg_proc WHERE oid = v_oid;
  IF NOT v_before.prosecdef OR v_before.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'video_wallet_guard: unexpected wallet security';
  END IF;

  v_definition := pg_get_functiondef(v_oid);
  -- Only the known guard may change; never replace the current helper with an old full definition.
  IF length(v_definition) - length(replace(v_definition, v_old, '')) = length(v_old)
     AND strpos(v_definition, v_new) = 0 THEN
    v_expected_body := replace(v_before.prosrc, v_old, v_new);
    EXECUTE replace(v_definition, v_old, v_new);
  ELSIF length(v_definition) - length(replace(v_definition, v_new, '')) = length(v_new)
     AND strpos(v_definition, v_old) = 0 THEN
    v_expected_body := v_before.prosrc;
  ELSE
    RAISE EXCEPTION 'video_wallet_guard: unknown or duplicate entry guard';
  END IF;

  IF to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)')::OID IS DISTINCT FROM v_oid THEN
    RAISE EXCEPTION 'video_wallet_guard: function identity changed';
  END IF;
  SELECT proowner, proacl, proconfig, prosecdef, provolatile, proparallel,
    proisstrict, proleakproof, procost, prorows, prosrc
  INTO v_after FROM pg_proc WHERE oid = v_oid;
  IF v_after.prosrc IS DISTINCT FROM v_expected_body
     OR (to_jsonb(v_after) - 'prosrc') IS DISTINCT FROM (to_jsonb(v_before) - 'prosrc') THEN
    RAISE EXCEPTION 'video_wallet_guard: wallet body or attributes changed';
  END IF;
END;
$guard$;


CREATE OR REPLACE FUNCTION billing.reserve_media_plaza_video(
  p_attempt_id UUID,
  p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt media_plaza.video_attempts%ROWTYPE;
  v_debit JSONB;
BEGIN
  SELECT * INTO v_attempt
  FROM media_plaza.video_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR v_attempt.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'video attempt not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_attempt.debit_ledger_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_reserved', 'attempt_id', v_attempt.id,
      'ledger_id', v_attempt.debit_ledger_id, 'credits', v_attempt.credits_charged);
  END IF;
  IF v_attempt.status <> 'pending' THEN
    RAISE EXCEPTION 'video attempt is not reservable' USING ERRCODE = '55000';
  END IF;

  -- Serialize admission per user so two API replicas cannot both pass the active-job limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('media-plaza-video:' || p_user_id::TEXT, 0));
  IF (
    SELECT count(*)
    FROM media_plaza.video_attempts
    WHERE user_id = p_user_id
      AND id <> p_attempt_id
      AND status IN ('submitting', 'queued', 'processing', 'storing')
  ) >= 2 THEN
    UPDATE media_plaza.video_attempts
    SET status = 'failed', error_code = 'too_many_active', completed_at = now(), updated_at = now()
    WHERE id = v_attempt.id;
    RETURN jsonb_build_object('status', 'too_many_active', 'attempt_id', v_attempt.id);
  END IF;

  BEGIN
    v_debit := billing.apply_wallet_debit(
      p_user_id,
      'media_plaza_video_reserve:' || v_attempt.id::TEXT,
      'main_then_bonus',
      v_attempt.quote_credits,
      'media_plaza_video_reserve',
      'media_plaza_video_reserve',
      v_attempt.id::TEXT,
      jsonb_build_object('attempt_id', v_attempt.id, 'quote_id', v_attempt.quote_id)
    );
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM IN ('MAIN_CREDITS_INSUFFICIENT', 'TOTAL_CREDITS_INSUFFICIENT') THEN
        UPDATE media_plaza.video_attempts
        SET status = 'failed', error_code = 'insufficient_balance', completed_at = now(), updated_at = now()
        WHERE id = v_attempt.id;
        RETURN jsonb_build_object('status', 'insufficient_balance', 'attempt_id', v_attempt.id);
      END IF;
      RAISE;
  END;

  UPDATE media_plaza.video_attempts
  SET status = 'submitting',
      debit_ledger_id = (v_debit->>'ledger_id')::UUID,
      credits_charged = quote_credits,
      charged_at = now(),
      error_code = NULL,
      updated_at = now()
  WHERE id = v_attempt.id
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('status', 'reserved', 'attempt_id', v_attempt.id,
    'ledger_id', v_attempt.debit_ledger_id, 'credits', v_attempt.credits_charged);
END;
$$;

CREATE OR REPLACE FUNCTION billing.refund_media_plaza_video(
  p_attempt_id UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt media_plaza.video_attempts%ROWTYPE;
  v_refund JSONB;
BEGIN
  SELECT * INTO v_attempt
  FROM media_plaza.video_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'video attempt not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_attempt.debit_ledger_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_reserved', 'attempt_id', v_attempt.id);
  END IF;
  IF v_attempt.refund_ledger_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'attempt_id', v_attempt.id,
      'ledger_id', v_attempt.refund_ledger_id);
  END IF;

  v_refund := billing.refund_wallet_debit(
    'media_plaza_video_refund:' || v_attempt.id::TEXT,
    'media_plaza_video_reserve:' || v_attempt.id::TEXT,
    left(COALESCE(p_reason, 'video_generation_failed'), 240)
  );

  UPDATE billing.wallet_ledger
  SET entry_type = 'media_plaza_video_refund',
      reference_type = 'media_plaza_video_refund',
      reference_id = v_attempt.id::TEXT
  WHERE id = (v_refund->>'ledger_id')::UUID
    AND entry_type = 'refund';

  UPDATE media_plaza.video_attempts
  SET refund_ledger_id = (v_refund->>'ledger_id')::UUID,
      refunded_at = COALESCE(refunded_at, now()),
      updated_at = now()
  WHERE id = v_attempt.id
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('status', v_refund->>'status', 'attempt_id', v_attempt.id,
    'ledger_id', v_attempt.refund_ledger_id);
END;
$$;

CREATE OR REPLACE FUNCTION media_plaza.claim_video_submit_jobs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 2,
  p_lease_seconds INTEGER DEFAULT 180
) RETURNS SETOF media_plaza.video_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF trim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT attempt.id
    FROM media_plaza.video_attempts AS attempt
    WHERE attempt.status = 'submitting'
      AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at < now())
    ORDER BY attempt.created_at, attempt.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2), 1), 10)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE media_plaza.video_attempts AS attempt
  SET lease_owner = left(p_worker_id, 128),
      lease_expires_at = now() + make_interval(secs =>
        LEAST(GREATEST(COALESCE(p_lease_seconds, 180), 30), 900)),
      updated_at = now()
  FROM candidates
  WHERE attempt.id = candidates.id
  RETURNING attempt.*;
END;
$$;

CREATE OR REPLACE FUNCTION media_plaza.claim_video_poll_jobs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 2,
  p_lease_seconds INTEGER DEFAULT 60
) RETURNS SETOF media_plaza.video_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF trim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT attempt.id
    FROM media_plaza.video_attempts AS attempt
    WHERE attempt.status IN ('queued', 'processing')
      AND attempt.next_poll_at <= now()
      AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at < now())
    ORDER BY attempt.next_poll_at, attempt.created_at, attempt.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2), 1), 10)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE media_plaza.video_attempts AS attempt
  SET lease_owner = left(p_worker_id, 128),
      lease_expires_at = now() + make_interval(secs =>
        LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 300)),
      updated_at = now()
  FROM candidates
  WHERE attempt.id = candidates.id
  RETURNING attempt.*;
END;
$$;

CREATE OR REPLACE FUNCTION media_plaza.publish_video_artifact(
  p_attempt_id UUID,
  p_worker_id TEXT,
  p_storage_path TEXT,
  p_byte_size BIGINT,
  p_width INTEGER,
  p_height INTEGER,
  p_duration_ms INTEGER,
  p_poster_path TEXT,
  p_poster_width INTEGER,
  p_poster_height INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt media_plaza.video_attempts%ROWTYPE;
  v_artifact media_plaza.video_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM media_plaza.video_attempts
  WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'video attempt not found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_artifact FROM media_plaza.video_artifacts WHERE attempt_id = p_attempt_id;
  IF v_attempt.status = 'ready' AND FOUND THEN
    RETURN jsonb_build_object('artifact_id', v_artifact.id, 'already_published', true);
  END IF;
  IF v_attempt.status <> 'storing' OR v_attempt.lease_owner IS DISTINCT FROM left(p_worker_id, 128)
     OR v_attempt.lease_expires_at < now() THEN
    RAISE EXCEPTION 'video attempt lease lost' USING ERRCODE = '55000';
  END IF;

  INSERT INTO media_plaza.video_artifacts(
    attempt_id, origin, storage_path, byte_size, width, height, duration_ms,
    poster_path, poster_width, poster_height
  ) VALUES (
    p_attempt_id, 'generated', p_storage_path, p_byte_size, p_width, p_height, p_duration_ms,
    p_poster_path, p_poster_width, p_poster_height
  ) RETURNING * INTO v_artifact;

  UPDATE media_plaza.video_attempts
  SET status = 'ready', download_url = NULL, lease_owner = NULL, lease_expires_at = NULL,
      completed_at = now(), updated_at = now()
  WHERE id = p_attempt_id AND lease_owner = left(p_worker_id, 128);
  IF NOT FOUND THEN RAISE EXCEPTION 'video attempt lease lost' USING ERRCODE = '55000'; END IF;

  RETURN jsonb_build_object('artifact_id', v_artifact.id, 'already_published', false);
END;
$$;

CREATE OR REPLACE FUNCTION billing.share_media_plaza_video(
  p_user_id UUID,
  p_artifact_id UUID,
  p_title TEXT,
  p_description TEXT,
  p_model_name TEXT,
  p_tags TEXT[],
  p_rebate_rate NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_artifact media_plaza.video_artifacts%ROWTYPE;
  v_attempt media_plaza.video_attempts%ROWTYPE;
  v_work media_plaza.image_plaza_works%ROWTYPE;
  v_reward NUMERIC(14,1);
  v_reward_ledger UUID;
  v_grant RECORD;
BEGIN
  IF p_rebate_rate IS NULL OR p_rebate_rate < 0 OR p_rebate_rate > 1 THEN
    RAISE EXCEPTION 'invalid media plaza rebate rate' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_artifact FROM media_plaza.video_artifacts WHERE id = p_artifact_id;
  IF NOT FOUND OR v_artifact.origin <> 'generated' OR v_artifact.attempt_id IS NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_attempt FROM media_plaza.video_attempts
  WHERE id = v_artifact.attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.user_id <> p_user_id OR v_attempt.status <> 'ready'
     OR v_attempt.debit_ledger_id IS NULL OR v_attempt.refund_ledger_id IS NOT NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_work FROM media_plaza.image_plaza_works
  WHERE video_artifact_id = p_artifact_id;
  IF FOUND THEN
    SELECT reward_credits INTO v_reward FROM billing.image_plaza_share_rewards WHERE work_id = v_work.id;
    RETURN jsonb_build_object('work_id', v_work.id, 'already_shared', true,
      'reward_credits', COALESCE(v_reward, 0));
  END IF;

  INSERT INTO media_plaza.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name, width, height,
    tags, snapshot, media_type, video_artifact_id, video_attempt_id, duration_ms, description
  ) VALUES (
    p_user_id, NULL, NULL, left(trim(p_title), 80), v_attempt.model_id,
    left(trim(p_model_name), 80), v_artifact.width, v_artifact.height,
    COALESCE(p_tags, '{}'),
    jsonb_build_object(
      'prompt', v_attempt.prompt, 'model_id', v_attempt.model_id,
      'input_mode', v_attempt.input_mode, 'duration_s', v_attempt.duration_s,
      'resolution', v_attempt.resolution, 'aspect_ratio', v_attempt.aspect_ratio,
      'audio', v_attempt.audio, 'reference_artifact_id', v_attempt.reference_artifact_id
    ),
    'video', v_artifact.id, v_attempt.id, v_artifact.duration_ms,
    left(COALESCE(p_description, ''), 500)
  ) RETURNING * INTO v_work;

  v_reward := round(v_attempt.credits_charged * p_rebate_rate, 1);
  IF v_reward > 0 THEN
    SELECT * INTO v_grant FROM billing.grant_bonus_credits(
      p_user_id, v_reward, 'image_plaza_share_reward', 'image_plaza_share_reward',
      v_work.id::TEXT,
      jsonb_build_object('video_attempt_id', v_attempt.id,
        'debit_ledger_id', v_attempt.debit_ledger_id, 'rebate_rate', p_rebate_rate)
    );
    v_reward_ledger := v_grant.o_ledger_id;
  END IF;

  INSERT INTO billing.image_plaza_share_rewards(
    user_id, work_id, attempt_id, video_attempt_id, debit_ledger_id,
    reward_ledger_id, rebate_rate, debit_credits, reward_credits
  ) VALUES (
    p_user_id, v_work.id, NULL, v_attempt.id, v_attempt.debit_ledger_id,
    v_reward_ledger, p_rebate_rate, v_attempt.credits_charged, v_reward
  );
  -- First-share completion is derived from billing.image_plaza_share_rewards.

  RETURN jsonb_build_object('work_id', v_work.id, 'already_shared', false,
    'reward_credits', v_reward);
END;
$$;

CREATE OR REPLACE FUNCTION media_plaza.import_video_seed_work(
  p_source_video_id TEXT,
  p_source_video_url TEXT,
  p_source_heat INTEGER,
  p_storage_path TEXT,
  p_byte_size BIGINT,
  p_width INTEGER,
  p_height INTEGER,
  p_duration_ms INTEGER,
  p_poster_path TEXT,
  p_poster_width INTEGER,
  p_poster_height INTEGER,
  p_title TEXT,
  p_description TEXT,
  p_model_id TEXT,
  p_model_name TEXT,
  p_snapshot JSONB,
  p_published_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_artifact media_plaza.video_artifacts%ROWTYPE;
  v_work media_plaza.image_plaza_works%ROWTYPE;
BEGIN
  IF trim(COALESCE(p_source_video_id, '')) = ''
     OR p_source_video_url !~ '^https://'
     OR p_source_heat IS NULL OR p_source_heat < 0
     OR trim(COALESCE(p_storage_path, '')) = ''
     OR char_length(trim(COALESCE(p_title, ''))) NOT BETWEEN 1 AND 80
     OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
     OR char_length(trim(COALESCE(p_snapshot->>'prompt', ''))) < 1
     OR char_length(trim(COALESCE(p_snapshot->>'prompt_zh', ''))) < 1
     OR p_snapshot->>'model_id' IS DISTINCT FROM p_model_id
     OR p_published_at IS NULL THEN
    RAISE EXCEPTION 'invalid video plaza seed work' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('media_plaza:video:' || p_source_video_id, 0));
  SELECT * INTO v_artifact FROM media_plaza.video_artifacts
  WHERE origin = 'civitai_seed' AND source_video_id = p_source_video_id;
  IF FOUND THEN
    SELECT * INTO STRICT v_work FROM media_plaza.image_plaza_works
    WHERE video_artifact_id = v_artifact.id;
    IF v_artifact.storage_path IS DISTINCT FROM p_storage_path
       OR v_artifact.source_video_url IS DISTINCT FROM p_source_video_url
       OR v_work.snapshot IS DISTINCT FROM p_snapshot THEN
      RAISE EXCEPTION 'video plaza seed idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('work_id', v_work.id, 'artifact_id', v_artifact.id,
      'already_imported', true);
  END IF;

  INSERT INTO media_plaza.video_artifacts(
    origin, storage_path, byte_size, width, height, duration_ms,
    poster_path, poster_width, poster_height, source_video_id, source_video_url
  ) VALUES (
    'civitai_seed', p_storage_path, p_byte_size, p_width, p_height, p_duration_ms,
    p_poster_path, p_poster_width, p_poster_height, p_source_video_id, p_source_video_url
  ) RETURNING * INTO v_artifact;

  INSERT INTO media_plaza.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name, width, height,
    tags, snapshot, published_at, origin, source_heat, media_type,
    video_artifact_id, video_attempt_id, duration_ms, description,
    source_video_id, source_video_url
  ) VALUES (
    NULL, NULL, NULL, trim(p_title), trim(p_model_id), trim(p_model_name), p_width, p_height,
    '{}', p_snapshot, p_published_at, 'civitai_seed', p_source_heat, 'video',
    v_artifact.id, NULL, p_duration_ms, left(COALESCE(p_description, ''), 500),
    p_source_video_id, p_source_video_url
  ) RETURNING * INTO v_work;

  RETURN jsonb_build_object('work_id', v_work.id, 'artifact_id', v_artifact.id,
    'already_imported', false);
END;
$$;

REVOKE ALL ON FUNCTION billing.reserve_media_plaza_video(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.refund_media_plaza_video(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION media_plaza.claim_video_submit_jobs(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION media_plaza.claim_video_poll_jobs(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION media_plaza.publish_video_artifact(
  UUID, TEXT, TEXT, BIGINT, INTEGER, INTEGER, INTEGER, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.share_media_plaza_video(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], NUMERIC
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION media_plaza.import_video_seed_work(
  TEXT, TEXT, INTEGER, TEXT, BIGINT, INTEGER, INTEGER, INTEGER, TEXT, INTEGER,
  INTEGER, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION billing.reserve_media_plaza_video(UUID, UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION billing.refund_media_plaza_video(UUID, TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION media_plaza.claim_video_submit_jobs(TEXT, INTEGER, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION media_plaza.claim_video_poll_jobs(TEXT, INTEGER, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION media_plaza.publish_video_artifact(
  UUID, TEXT, TEXT, BIGINT, INTEGER, INTEGER, INTEGER, TEXT, INTEGER, INTEGER
) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION billing.share_media_plaza_video(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], NUMERIC
) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION media_plaza.import_video_seed_work(
  TEXT, TEXT, INTEGER, TEXT, BIGINT, INTEGER, INTEGER, INTEGER, TEXT, INTEGER,
  INTEGER, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) TO service_role, postgres;

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media-plaza-video', 'media-plaza-video', false, 209715200,
  ARRAY['video/mp4', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;
-- Existing private cover bucket settings and uploaded objects are preserved.

ALTER TABLE media_plaza.image_plaza_messages
  VALIDATE CONSTRAINT image_plaza_messages_media_shape_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM media_plaza.image_plaza_works
    WHERE (media_type = 'image') IS DISTINCT FROM (artifact_id IS NOT NULL)
       OR (media_type = 'video') IS DISTINCT FROM (video_artifact_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'media plaza M2 postflight work shape mismatch';
  END IF;
  IF has_table_privilege('anon', 'media_plaza.video_attempts', 'SELECT')
     OR has_function_privilege('authenticated', 'billing.reserve_media_plaza_video(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'media plaza M2 postflight privilege leak';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
