-- domain: experience
-- Separate contract after every writer sharing this database uses canonical fields.
-- Keeps llm_generation_id/data: these are identities/allowlisted diagnostics, not aliases.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  field record;
  pending bigint;
  field_conflict boolean;
  legacy_columns smallint[];
  known_constraints oid[];
BEGIN
  FOR field IN SELECT * FROM (VALUES
    ('provider_name','text'), ('finish_reason','text'), ('usage','jsonb'), ('usage_cache','jsonb'),
    ('native_tokens_cached','integer'), ('native_tokens_reasoning','integer'),
    ('native_tokens_completion','integer'), ('native_tokens_prompt','integer'),
    ('latency','numeric'), ('generation_time','numeric'), ('model','text')
  ) AS fields(name, typ)
  LOOP
    IF (SELECT count(*) FROM pg_attribute
      WHERE attrelid='experience.openrouter_chat_history'::regclass AND attnum>0 AND NOT attisdropped
        AND attname IN (field.name,'llm_' || field.name)
        AND format_type(atttypid,atttypmod)=field.typ)<>2
      THEN RAISE EXCEPTION 'Unexpected OpenRouter alias/canonical shape: %',field.name; END IF;
    -- Distinct non-null facts need review. Never replace a newer canonical value.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE %I IS NOT NULL AND %I IS NOT NULL AND %I IS DISTINCT FROM %I)',
      field.name,'llm_' || field.name,field.name,'llm_' || field.name) INTO field_conflict;
    IF field_conflict THEN RAISE EXCEPTION 'Conflicting OpenRouter alias/canonical facts: %',field.name; END IF;
  END LOOP;

  SELECT count(*) INTO pending FROM experience.openrouter_chat_history WHERE
    (provider_name IS NULL AND llm_provider_name IS NOT NULL) OR
    (finish_reason IS NULL AND llm_finish_reason IS NOT NULL) OR
    (usage IS NULL AND llm_usage IS NOT NULL) OR
    (usage_cache IS NULL AND llm_usage_cache IS NOT NULL) OR
    (native_tokens_cached IS NULL AND llm_native_tokens_cached IS NOT NULL) OR
    (native_tokens_reasoning IS NULL AND llm_native_tokens_reasoning IS NOT NULL) OR
    (native_tokens_completion IS NULL AND llm_native_tokens_completion IS NOT NULL) OR
    (native_tokens_prompt IS NULL AND llm_native_tokens_prompt IS NOT NULL) OR
    (latency IS NULL AND llm_latency IS NOT NULL) OR
    (generation_time IS NULL AND llm_generation_time IS NOT NULL) OR
    (model IS NULL AND llm_model IS NOT NULL);
  IF pending>2000 THEN RAISE EXCEPTION 'OpenRouter alias catch-up exceeds reviewed 2000-row budget'; END IF;

  IF EXISTS (SELECT 1 FROM experience.openrouter_chat_history o JOIN experience.venice_chat_history v USING(chat_history_id))
    THEN RAISE EXCEPTION 'Provider overlap'; END IF;

  SELECT array_agg(attnum) INTO legacy_columns FROM pg_attribute
    WHERE attrelid='experience.openrouter_chat_history'::regclass AND NOT attisdropped
      AND attname=ANY(ARRAY['llm_provider_name','llm_finish_reason','llm_usage','llm_usage_cache',
        'llm_native_tokens_cached','llm_native_tokens_reasoning','llm_native_tokens_completion',
        'llm_native_tokens_prompt','llm_latency','llm_generation_time','llm_model']);
  -- Only the eight obsolete single-alias checks may be removed. An unknown view,
  -- index, policy, function or mixed canonical constraint must stop this contract.
  SELECT array_agg(oid) INTO known_constraints FROM pg_constraint
    WHERE conrelid='experience.openrouter_chat_history'::regclass AND contype='c'
      AND array_length(conkey,1)=1 AND conkey <@ legacy_columns
      AND conname=ANY(ARRAY['openrouter_chat_history_usage_number_check',
        'openrouter_chat_history_usage_cache_number_check','openrouter_chat_history_cached_tokens_check',
        'openrouter_chat_history_reasoning_tokens_check','openrouter_chat_history_completion_tokens_check',
        'openrouter_chat_history_prompt_tokens_check','openrouter_chat_history_latency_check',
        'openrouter_chat_history_generation_time_check']);
  IF coalesce(array_length(known_constraints,1),0)<>8
    THEN RAISE EXCEPTION 'Unexpected legacy OpenRouter check constraints'; END IF;
  IF EXISTS (SELECT 1 FROM pg_depend d
    WHERE d.refclassid='pg_class'::regclass AND d.refobjid='experience.openrouter_chat_history'::regclass
      AND d.refobjsubid=ANY(legacy_columns)
      AND NOT (d.classid='pg_constraint'::regclass AND d.objid=ANY(known_constraints)))
    THEN RAISE EXCEPTION 'OpenRouter alias database dependency remains'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='experience.openrouter_chat_history'::regclass
    AND conname='openrouter_chat_history_original_fields_check' AND contype='c' AND convalidated)
    THEN RAISE EXCEPTION 'Canonical OpenRouter checks missing'; END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='experience.openrouter_chat_history'::regclass
    AND NOT attisdropped AND attname=ANY(ARRAY['chat_history_id','llm_generation_id','llm_generation_data']))<>3
    THEN RAISE EXCEPTION 'OpenRouter identity/diagnostic shape mismatch'; END IF;
END $$;

-- Copy only typed scalar aliases in this provider's own row, never parent business
-- finish_reason or historical raw JSON. The bounded update preserves zero and NULL.
UPDATE experience.openrouter_chat_history SET
  provider_name=coalesce(provider_name,llm_provider_name),
  finish_reason=coalesce(finish_reason,llm_finish_reason),
  usage=coalesce(usage,llm_usage), usage_cache=coalesce(usage_cache,llm_usage_cache),
  native_tokens_cached=coalesce(native_tokens_cached,llm_native_tokens_cached),
  native_tokens_reasoning=coalesce(native_tokens_reasoning,llm_native_tokens_reasoning),
  native_tokens_completion=coalesce(native_tokens_completion,llm_native_tokens_completion),
  native_tokens_prompt=coalesce(native_tokens_prompt,llm_native_tokens_prompt),
  latency=coalesce(latency,llm_latency), generation_time=coalesce(generation_time,llm_generation_time),
  model=coalesce(model,llm_model)
WHERE (provider_name IS NULL AND llm_provider_name IS NOT NULL) OR
  (finish_reason IS NULL AND llm_finish_reason IS NOT NULL) OR
  (usage IS NULL AND llm_usage IS NOT NULL) OR (usage_cache IS NULL AND llm_usage_cache IS NOT NULL) OR
  (native_tokens_cached IS NULL AND llm_native_tokens_cached IS NOT NULL) OR
  (native_tokens_reasoning IS NULL AND llm_native_tokens_reasoning IS NOT NULL) OR
  (native_tokens_completion IS NULL AND llm_native_tokens_completion IS NOT NULL) OR
  (native_tokens_prompt IS NULL AND llm_native_tokens_prompt IS NOT NULL) OR
  (latency IS NULL AND llm_latency IS NOT NULL) OR
  (generation_time IS NULL AND llm_generation_time IS NOT NULL) OR (model IS NULL AND llm_model IS NOT NULL);

ALTER TABLE experience.openrouter_chat_history
  DROP CONSTRAINT openrouter_chat_history_usage_number_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_usage_cache_number_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_cached_tokens_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_reasoning_tokens_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_completion_tokens_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_prompt_tokens_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_latency_check RESTRICT,
  DROP CONSTRAINT openrouter_chat_history_generation_time_check RESTRICT,
  DROP COLUMN llm_provider_name RESTRICT,
  DROP COLUMN llm_finish_reason RESTRICT,
  DROP COLUMN llm_usage RESTRICT,
  DROP COLUMN llm_usage_cache RESTRICT,
  DROP COLUMN llm_native_tokens_cached RESTRICT,
  DROP COLUMN llm_native_tokens_reasoning RESTRICT,
  DROP COLUMN llm_native_tokens_completion RESTRICT,
  DROP COLUMN llm_native_tokens_prompt RESTRICT,
  DROP COLUMN llm_latency RESTRICT,
  DROP COLUMN llm_generation_time RESTRICT,
  DROP COLUMN llm_model RESTRICT;
NOTIFY pgrst,'reload schema';
COMMIT;
-- Recovery: only a canonical-field Backend or reviewed forward-fix. Do not revert
-- to alias writers, restore empty aliases as fake recovery, or rewrite the table.

