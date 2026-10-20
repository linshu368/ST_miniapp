-- domain: experience
-- Forward recovery for the immutable 20261016 catch-up. Review the T11 release gates first.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $recovery$
DECLARE
  legacy_columns integer;
  candidate_count integer;
  batch_number integer;
  previous_mergejoin text := current_setting('enable_mergejoin');
  previous_nestloop text := current_setting('enable_nestloop');
BEGIN
  IF to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.openrouter_chat_history') IS NULL
     OR to_regclass('experience.venice_chat_history') IS NULL THEN
    RAISE EXCEPTION 'Catch-up recovery requires all three provider history tables';
  END IF;
  SELECT count(*) INTO legacy_columns FROM pg_attribute
  WHERE attrelid='experience.chat_history'::regclass AND attnum>0 AND NOT attisdropped
    AND attname=ANY(ARRAY['llm_provider_name','llm_usage','llm_usage_cache',
      'llm_native_tokens_cached','llm_native_tokens_reasoning','llm_native_tokens_completion',
      'llm_native_tokens_prompt','llm_latency','llm_generation_time','llm_model',
      'llm_generation_id','llm_generation_data']);
  -- TEST may already be contracted. Shape alone cannot prove that the reviewed DROP ran.
  IF legacy_columns=0 THEN
    IF NOT EXISTS (SELECT 1 FROM supabase_migrations.repo_migrations
      WHERE filename='20261016_chat_history_drop_provider_metadata.sql'
        AND checksum='d1b410064f06b63a40a9c15a9b8148e3e43cf3cfdbadaba198b60fcbd7766852') THEN
      RAISE EXCEPTION 'Contracted history requires matching reviewed DROP ledger';
    END IF;
    RAISE NOTICE 'Catch-up recovery skipped: reviewed parent contract already applied';
    RETURN;
  END IF;
  IF legacy_columns<>12 THEN
    RAISE EXCEPTION 'Catch-up recovery requires exactly 12 legacy columns';
  END IF;

  IF EXISTS (SELECT 1 FROM experience.venice_chat_history v JOIN experience.openrouter_chat_history o USING(chat_history_id))
    THEN RAISE EXCEPTION 'Provider overlap; stop retirement'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
      WHERE h.llm_generation_id IS NOT NULL AND o.llm_generation_id IS NOT NULL AND h.llm_generation_id<>o.llm_generation_id)
    THEN RAISE EXCEPTION 'OpenRouter identity conflict'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
      WHERE h.llm_generation_id IS NOT NULL AND v.llm_generation_id IS NOT NULL AND h.llm_generation_id<>v.llm_generation_id)
    THEN RAISE EXCEPTION 'Venice identity conflict'; END IF;

  CREATE TEMP TABLE retirement_recovery_candidates(id uuid PRIMARY KEY) ON COMMIT DROP;
  -- Production merge joins walked both large heaps in UUID order and exceeded 60s.
  -- Only this ID scan uses hash joins; keep planner changes local and restore before writes.
  PERFORM set_config('enable_mergejoin','off',true);
  PERFORM set_config('enable_nestloop','off',true);
  INSERT INTO retirement_recovery_candidates(id)
    SELECT h.id FROM experience.chat_history h
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
    WHERE v.chat_history_id IS NULL AND (
      (h.llm_generation_id IS NOT NULL AND o.llm_generation_id IS NULL) OR
      (h.llm_provider_name IS NOT NULL AND o.provider_name IS NULL) OR
      (h.llm_usage IS NOT NULL AND o.usage IS NULL) OR
      (h.llm_usage_cache IS NOT NULL AND o.usage_cache IS NULL) OR
      (h.llm_native_tokens_cached IS NOT NULL AND o.native_tokens_cached IS NULL) OR
      (h.llm_native_tokens_reasoning IS NOT NULL AND o.native_tokens_reasoning IS NULL) OR
      (h.llm_native_tokens_completion IS NOT NULL AND o.native_tokens_completion IS NULL) OR
      (h.llm_native_tokens_prompt IS NOT NULL AND o.native_tokens_prompt IS NULL) OR
      (h.llm_latency IS NOT NULL AND o.latency IS NULL) OR
      (h.llm_generation_time IS NOT NULL AND o.generation_time IS NULL) OR
      (h.llm_model IS NOT NULL AND o.model IS NULL)
    )
    LIMIT 4001;
  PERFORM set_config('enable_mergejoin',previous_mergejoin,true);
  PERFORM set_config('enable_nestloop',previous_nestloop,true);

  SELECT count(*) INTO candidate_count FROM retirement_recovery_candidates;
  IF candidate_count>4000 THEN
    RAISE EXCEPTION 'Catch-up recovery exceeds reviewed two-batch 4000-row budget';
  END IF;
  ANALYZE retirement_recovery_candidates;
  -- Freeze only candidate parents while validating identity/provider and copying scalars.
  -- The release gate must still prove that every old metadata writer has exited.
  PERFORM 1 FROM retirement_recovery_candidates c JOIN experience.chat_history h USING(id)
    FOR SHARE OF h;
  IF EXISTS (SELECT 1 FROM retirement_recovery_candidates c JOIN experience.chat_history h USING(id)
    WHERE h.llm_billing_snapshot->>'provider'='venice') THEN
    RAISE EXCEPTION 'Venice snapshot without Venice detail';
  END IF;

  FOR batch_number IN 0..1 LOOP
    -- Two bounded write sets share one transaction: a failure in batch two rolls back both.
    INSERT INTO experience.openrouter_chat_history (
      chat_history_id, llm_generation_id, provider_name, usage, usage_cache,
      native_tokens_cached, native_tokens_reasoning, native_tokens_completion,
      native_tokens_prompt, latency, generation_time, model, created_at
    )
    SELECT h.id, h.llm_generation_id, h.llm_provider_name,
      CASE WHEN jsonb_typeof(h.llm_usage)='number' THEN
        CASE WHEN (h.llm_usage #>> '{}')::numeric >= 0 THEN h.llm_usage END END,
      CASE WHEN jsonb_typeof(h.llm_usage_cache)='number' THEN
        CASE WHEN (h.llm_usage_cache #>> '{}')::numeric >= 0 THEN h.llm_usage_cache END END,
      CASE WHEN h.llm_native_tokens_cached >= 0 THEN h.llm_native_tokens_cached END,
      CASE WHEN h.llm_native_tokens_reasoning >= 0 THEN h.llm_native_tokens_reasoning END,
      CASE WHEN h.llm_native_tokens_completion >= 0 THEN h.llm_native_tokens_completion END,
      CASE WHEN h.llm_native_tokens_prompt >= 0 THEN h.llm_native_tokens_prompt END,
      CASE WHEN h.llm_latency >= 0 THEN h.llm_latency END,
      CASE WHEN h.llm_generation_time >= 0 THEN h.llm_generation_time END,
      h.llm_model, h.created_at
    FROM (
      SELECT id FROM retirement_recovery_candidates
      ORDER BY id LIMIT 2000 OFFSET batch_number * 2000
    ) c
    JOIN experience.chat_history h USING(id)
    WHERE h.llm_generation_id IS NOT NULL OR h.llm_billing_snapshot->>'provider'='openrouter'
    ON CONFLICT (chat_history_id) DO UPDATE SET
      llm_generation_id=COALESCE(experience.openrouter_chat_history.llm_generation_id, EXCLUDED.llm_generation_id),
      provider_name=COALESCE(experience.openrouter_chat_history.provider_name, EXCLUDED.provider_name),
      usage=COALESCE(experience.openrouter_chat_history.usage, EXCLUDED.usage),
      usage_cache=COALESCE(experience.openrouter_chat_history.usage_cache, EXCLUDED.usage_cache),
      native_tokens_cached=COALESCE(experience.openrouter_chat_history.native_tokens_cached, EXCLUDED.native_tokens_cached),
      native_tokens_reasoning=COALESCE(experience.openrouter_chat_history.native_tokens_reasoning, EXCLUDED.native_tokens_reasoning),
      native_tokens_completion=COALESCE(experience.openrouter_chat_history.native_tokens_completion, EXCLUDED.native_tokens_completion),
      native_tokens_prompt=COALESCE(experience.openrouter_chat_history.native_tokens_prompt, EXCLUDED.native_tokens_prompt),
      latency=COALESCE(experience.openrouter_chat_history.latency, EXCLUDED.latency),
      generation_time=COALESCE(experience.openrouter_chat_history.generation_time, EXCLUDED.generation_time),
      model=COALESCE(experience.openrouter_chat_history.model, EXCLUDED.model),
      updated_at=now()
    WHERE experience.openrouter_chat_history.llm_generation_id IS NULL
       OR EXCLUDED.llm_generation_id IS NULL
       OR experience.openrouter_chat_history.llm_generation_id=EXCLUDED.llm_generation_id;
  END LOOP;

  -- Venice retains its existing mapper/schema; only its missing identity can be filled.
  UPDATE experience.venice_chat_history v SET llm_generation_id=h.llm_generation_id, updated_at=now()
  FROM experience.chat_history h WHERE h.id=v.chat_history_id
    AND v.llm_generation_id IS NULL AND h.llm_generation_id IS NOT NULL;

  -- A competing provider/identity writer must not turn a skipped upsert into silent success.
  IF EXISTS (SELECT 1 FROM experience.venice_chat_history v JOIN experience.openrouter_chat_history o USING(chat_history_id))
    THEN RAISE EXCEPTION 'Provider overlap; stop retirement'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
      WHERE h.llm_generation_id IS NOT NULL AND o.llm_generation_id IS NOT NULL AND h.llm_generation_id<>o.llm_generation_id)
    THEN RAISE EXCEPTION 'OpenRouter identity conflict'; END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_history h JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
      WHERE h.llm_generation_id IS NOT NULL AND v.llm_generation_id IS NOT NULL AND h.llm_generation_id<>v.llm_generation_id)
    THEN RAISE EXCEPTION 'Venice identity conflict'; END IF;

  RAISE NOTICE 'Catch-up recovery scanned % candidates in at most two 2000-row batches', candidate_count;
END
$recovery$;
COMMIT;
-- Recovery: retain additive detail rows. Any guard/lock/statement failure rolls back this file.
-- Do not rewrite the old migration, clear its matching claim, or forge its ledger entry.
