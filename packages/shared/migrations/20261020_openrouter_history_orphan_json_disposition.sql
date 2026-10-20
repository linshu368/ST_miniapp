-- domain: experience
-- Pre-step for 20261020_openrouter_history_disposition_recovery.sql (unchanged; its claim and
-- the DROP recovery's checksum stay valid). Production 2026-10-20 read-only audit: 3 parents with
-- legacy JSON had no provider detail, no generation ID, no billing snapshot and no allowlisted
-- facts, so the recovery's provider/identity guard rejected their batch. With no provable
-- provider there is nowhere to normalize them; only non-allowlisted diagnostics are discarded.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $orphan$
DECLARE present integer; candidate_count integer; cleared integer;
  previous_mergejoin text := current_setting('enable_mergejoin');
  previous_nestloop text := current_setting('enable_nestloop');
BEGIN
  SELECT count(*) INTO present FROM pg_attribute
  WHERE attrelid='experience.chat_history'::regclass AND attnum>0 AND NOT attisdropped
    AND attname='llm_generation_data';
  IF present=0 THEN
    IF NOT EXISTS (SELECT 1 FROM supabase_migrations.repo_migrations
      WHERE filename='20261016_chat_history_drop_provider_metadata.sql'
        AND checksum='d1b410064f06b63a40a9c15a9b8148e3e43cf3cfdbadaba198b60fcbd7766852') THEN
      RAISE EXCEPTION 'Contracted history requires matching reviewed DROP ledger';
    END IF;
    RAISE NOTICE 'Orphan history JSON disposition skipped: reviewed parent contract already applied';
    RETURN;
  END IF;

  CREATE TEMP TABLE orphan_history_candidates(id uuid PRIMARY KEY, fingerprint text) ON COMMIT DROP;
  -- Same planner restriction as the recovery manifest: avoid UUID-ordered merge joins.
  PERFORM set_config('enable_mergejoin','off',true);
  PERFORM set_config('enable_nestloop','off',true);
  INSERT INTO orphan_history_candidates(id)
    SELECT h.id FROM experience.chat_history h
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
    WHERE h.llm_generation_data IS NOT NULL AND o.chat_history_id IS NULL AND v.chat_history_id IS NULL
    LIMIT 101;
  PERFORM set_config('enable_mergejoin',previous_mergejoin,true);
  PERFORM set_config('enable_nestloop',previous_nestloop,true);
  SELECT count(*) INTO candidate_count FROM orphan_history_candidates;
  -- Audited count is 3; a larger set means an unreviewed cohort or a live old writer.
  IF candidate_count>100 THEN
    RAISE EXCEPTION 'Orphan history JSON exceeds reviewed 100-row budget';
  END IF;

  PERFORM 1 FROM orphan_history_candidates c JOIN experience.chat_history h USING(id) FOR UPDATE OF h;
  UPDATE orphan_history_candidates c SET fingerprint=md5(h.llm_generation_data::text)
  FROM experience.chat_history h WHERE h.id=c.id;

  -- Any provider evidence, in-flight call or allowlisted key (by presence, regardless of type)
  -- needs manual attribution; never guess a provider or fabricate an ID.
  IF EXISTS (SELECT 1 FROM orphan_history_candidates c JOIN experience.chat_history h USING(id)
    WHERE jsonb_typeof(h.llm_generation_data)<>'object'
      OR h.llm_generation_id IS NOT NULL
      OR h.llm_billing_snapshot IS NOT NULL
      OR h.status='streaming'
      OR h.llm_generation_data ?| ARRAY['id','provider_name','finish_reason','model','usage','usage_cache',
        'native_tokens_cached','native_tokens_reasoning','native_tokens_completion','native_tokens_prompt',
        'latency','generation_time'])
    THEN RAISE EXCEPTION 'Orphan history JSON requires manual provider classification'; END IF;

  UPDATE experience.chat_history h SET llm_generation_data=NULL
  FROM orphan_history_candidates c WHERE c.id=h.id AND md5(h.llm_generation_data::text)=c.fingerprint;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  IF cleared<>candidate_count THEN
    RAISE EXCEPTION 'Orphan history JSON changed during disposition';
  END IF;
  RAISE NOTICE 'Orphan history JSON disposition cleared % parents', cleared;
END $orphan$;
COMMIT;
-- Discarded diagnostics (including any error code) are intentionally irrecoverable; no
-- prompt/reply, status, billing or provider table is written. Re-running is a no-op.
