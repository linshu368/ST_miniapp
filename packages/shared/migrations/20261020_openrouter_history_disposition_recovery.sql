-- domain: experience
-- Forward replacement for 20261016_openrouter_history_disposition.sql.
-- Immutable old SQL/claims/ledger remain untouched. Only this filename is recorded.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Production read-only count on 2026-10-20: 295383 candidates; hard cap 300000.
-- Freeze IDs once: normalized non-NULL provider diagnostics remain candidates on re-entry.
-- Never paginate by repeatedly selecting the first 2000 non-NULL diagnostics.
CREATE TEMP TABLE history_disposition_manifest(id uuid PRIMARY KEY) ON COMMIT PRESERVE ROWS;
DO $manifest$
DECLARE present integer;
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
    RAISE NOTICE 'History disposition recovery skipped: reviewed parent contract already applied';
    RETURN;
  END IF;
  -- Avoid UUID-ordered merge joins walking large parent/provider heaps.
  PERFORM set_config('enable_mergejoin','off',true);
  PERFORM set_config('enable_nestloop','off',true);
  INSERT INTO history_disposition_manifest(id)
    SELECT h.id FROM experience.chat_history h
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    WHERE h.llm_generation_data IS NOT NULL OR o.llm_generation_data IS NOT NULL
    LIMIT 300001;
  PERFORM set_config('enable_mergejoin',previous_mergejoin,true);
  PERFORM set_config('enable_nestloop',previous_nestloop,true);
  IF (SELECT count(*) FROM history_disposition_manifest)>300000 THEN
    RAISE EXCEPTION 'History disposition recovery exceeds 300000-row budget';
  END IF;
  RAISE NOTICE 'History disposition recovery fixed % candidates in at most 150 independent 2000-row batches',
    (SELECT count(*) FROM history_disposition_manifest);
END $manifest$;
ANALYZE history_disposition_manifest;

CREATE FUNCTION pg_temp.retirement_safe_metadata(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb='{}'; key text; number numeric;
BEGIN
  FOREACH key IN ARRAY ARRAY['id','provider_name','finish_reason','model'] LOOP
    IF jsonb_typeof(value->key)='string' THEN
      IF length(value->>key)>512 THEN RAISE EXCEPTION 'Oversized historical metadata string'; END IF;
      result=result || jsonb_build_object(key,value->key);
    END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['usage','usage_cache','native_tokens_cached','native_tokens_reasoning',
    'native_tokens_completion','native_tokens_prompt','latency','generation_time'] LOOP
    IF jsonb_typeof(value->key)='number' THEN
      number=(value->>key)::numeric;
      IF number>=0 AND number<=1e308::numeric AND
        (key NOT LIKE 'native_tokens_%' OR (number=trunc(number) AND number<=2147483647)) THEN
        result=result || jsonb_build_object(key,value->key);
      END IF;
    END IF;
  END LOOP;
  IF jsonb_typeof(value->'error')='object' THEN
    IF jsonb_typeof(value->'error'->'code')='number' AND abs((value->'error'->>'code')::numeric)<=1e308::numeric THEN
      result=result || jsonb_build_object('error',jsonb_build_object('code',value->'error'->'code'));
    ELSE result=result || '{"error":{}}'::jsonb;
    END IF;
  END IF;
  RETURN result;
END $$;
CREATE FUNCTION pg_temp.retirement_disposition_batch(batch_ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $batch$
BEGIN
  IF cardinality(batch_ids)=0 THEN RETURN; END IF;
CREATE TEMP TABLE history_disposition_candidates ON COMMIT DROP AS
SELECT id, NULL::text AS fingerprint, NULL::text AS detail_fingerprint
FROM history_disposition_manifest WHERE id=ANY(batch_ids);
-- Serialize provider metadata for this bounded batch, including the no-op path on resume.
-- Parent JSON remains protected by the original fingerprint CAS.
PERFORM 1 FROM history_disposition_candidates c
JOIN experience.openrouter_chat_history o ON o.chat_history_id=c.id FOR UPDATE OF o;
-- Do not detoast/hash a production-sized table before enforcing the batch budget.
UPDATE history_disposition_candidates c SET fingerprint=md5(h.llm_generation_data::text),
  detail_fingerprint=md5(o.llm_generation_data::text)
FROM experience.chat_history h LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
WHERE c.id=h.id;
  IF EXISTS (SELECT 1 FROM history_disposition_candidates c JOIN experience.chat_history h USING(id)
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
    WHERE (h.llm_generation_data IS NOT NULL AND jsonb_typeof(h.llm_generation_data)<>'object')
      OR (o.llm_generation_data IS NOT NULL AND jsonb_typeof(o.llm_generation_data)<>'object')
      OR (o.chat_history_id IS NULL)=(v.chat_history_id IS NULL)
      OR (h.llm_billing_snapshot->>'provider'='venice' AND v.chat_history_id IS NULL)
      OR (h.llm_billing_snapshot->>'provider'='openrouter' AND o.chat_history_id IS NULL)
      OR (h.llm_generation_id IS NOT NULL AND h.llm_generation_id IS DISTINCT FROM coalesce(o.llm_generation_id,v.llm_generation_id))
      OR (jsonb_typeof(h.llm_generation_data->'id')='string' AND
        h.llm_generation_data->>'id' IS DISTINCT FROM coalesce(o.llm_generation_id,v.llm_generation_id))
      OR (jsonb_typeof(o.llm_generation_data->'id')='string' AND
        o.llm_generation_data->>'id' IS DISTINCT FROM o.llm_generation_id))
    THEN RAISE EXCEPTION 'Unresolved historical JSON shape/provider/identity'; END IF;


CREATE TEMP TABLE history_disposition_safe ON COMMIT DROP AS
SELECT c.id,c.detail_fingerprint,
  pg_temp.retirement_safe_metadata(h.llm_generation_data) || pg_temp.retirement_safe_metadata(o.llm_generation_data) AS metadata
FROM history_disposition_candidates c JOIN experience.chat_history h USING(id)
LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
WHERE md5(h.llm_generation_data::text) IS NOT DISTINCT FROM c.fingerprint
  AND md5(o.llm_generation_data::text) IS NOT DISTINCT FROM c.detail_fingerprint;
  IF (SELECT count(*) FROM history_disposition_safe)<>(SELECT count(*) FROM history_disposition_candidates)
    THEN RAISE EXCEPTION 'Historical JSON changed during disposition'; END IF;


-- Re-entry validates every fixed ID, but does not rewrite already normalized provider rows.
ALTER TABLE history_disposition_safe ADD COLUMN needs_update boolean NOT NULL DEFAULT false;
UPDATE history_disposition_safe s SET needs_update=
  ROW(o.provider_name,o.finish_reason,o.usage,o.usage_cache,o.native_tokens_cached,o.native_tokens_reasoning,o.native_tokens_completion,o.native_tokens_prompt,o.latency,o.generation_time,o.model,o.llm_generation_data) IS DISTINCT FROM ROW(coalesce(o.provider_name,s.metadata->>'provider_name'),coalesce(o.finish_reason,s.metadata->>'finish_reason'),coalesce(o.usage,s.metadata->'usage'),coalesce(o.usage_cache,s.metadata->'usage_cache'),coalesce(o.native_tokens_cached,(s.metadata->>'native_tokens_cached')::integer),coalesce(o.native_tokens_reasoning,(s.metadata->>'native_tokens_reasoning')::integer),coalesce(o.native_tokens_completion,(s.metadata->>'native_tokens_completion')::integer),coalesce(o.native_tokens_prompt,(s.metadata->>'native_tokens_prompt')::integer),coalesce(o.latency,(s.metadata->>'latency')::numeric),coalesce(o.generation_time,(s.metadata->>'generation_time')::numeric),coalesce(o.model,s.metadata->>'model'),CASE WHEN o.llm_generation_data IS NULL THEN s.metadata
    ELSE pg_temp.retirement_safe_metadata(o.llm_generation_data) END)
FROM experience.openrouter_chat_history o WHERE o.chat_history_id=s.id;

-- Existing non-null provider facts are newer/authoritative; only fill missing facts.
CREATE TEMP TABLE history_disposition_written ON COMMIT DROP AS
WITH written AS (UPDATE experience.openrouter_chat_history o SET
  provider_name=coalesce(o.provider_name,s.metadata->>'provider_name'),
  finish_reason=coalesce(o.finish_reason,s.metadata->>'finish_reason'),
  usage=coalesce(o.usage,s.metadata->'usage'), usage_cache=coalesce(o.usage_cache,s.metadata->'usage_cache'),
  native_tokens_cached=coalesce(o.native_tokens_cached,(s.metadata->>'native_tokens_cached')::integer),
  native_tokens_reasoning=coalesce(o.native_tokens_reasoning,(s.metadata->>'native_tokens_reasoning')::integer),
  native_tokens_completion=coalesce(o.native_tokens_completion,(s.metadata->>'native_tokens_completion')::integer),
  native_tokens_prompt=coalesce(o.native_tokens_prompt,(s.metadata->>'native_tokens_prompt')::integer),
  latency=coalesce(o.latency,(s.metadata->>'latency')::numeric),
  generation_time=coalesce(o.generation_time,(s.metadata->>'generation_time')::numeric),
  model=coalesce(o.model,s.metadata->>'model'),
  llm_generation_data=CASE WHEN o.llm_generation_data IS NULL THEN s.metadata
    ELSE pg_temp.retirement_safe_metadata(o.llm_generation_data) END,updated_at=now()
FROM history_disposition_safe s WHERE s.id=o.chat_history_id AND s.needs_update
  AND md5(o.llm_generation_data::text) IS NOT DISTINCT FROM s.detail_fingerprint
RETURNING o.chat_history_id) SELECT chat_history_id FROM written;
  IF (SELECT count(*) FROM history_disposition_written)<>(SELECT count(*) FROM history_disposition_safe s
    JOIN experience.openrouter_chat_history o ON o.chat_history_id=s.id WHERE s.needs_update)
    THEN RAISE EXCEPTION 'Historical detail changed during disposition'; END IF;


-- Venice already owns its details. Do not rewrite its mapper, schema or diagnostics.
-- A missing typed fact needs a separately reviewed provider-specific fix, not loss.
  IF EXISTS (SELECT 1 FROM history_disposition_safe s JOIN experience.venice_chat_history v ON v.chat_history_id=s.id
    WHERE (s.metadata ? 'model' AND v.llm_model IS NULL)
      OR (s.metadata ? 'finish_reason' AND v.llm_finish_reason IS NULL)
      OR (s.metadata ? 'usage' AND v.llm_usage IS NULL)
      OR (s.metadata ? 'provider_name' AND v.llm_provider_name IS NULL)
      OR (s.metadata ? 'usage_cache' AND v.llm_usage_cache IS NULL)
      OR (s.metadata ? 'native_tokens_cached' AND v.llm_native_tokens_cached IS NULL)
      OR (s.metadata ? 'native_tokens_reasoning' AND v.llm_native_tokens_reasoning IS NULL)
      OR (s.metadata ? 'native_tokens_completion' AND v.llm_native_tokens_completion IS NULL)
      OR (s.metadata ? 'native_tokens_prompt' AND v.llm_native_tokens_prompt IS NULL)
      OR (s.metadata ? 'latency' AND v.llm_latency IS NULL)
      OR (s.metadata ? 'generation_time' AND v.llm_generation_time IS NULL))
    THEN RAISE EXCEPTION 'Unpreserved Venice historical JSON fact'; END IF;

UPDATE experience.chat_history h SET llm_generation_data=NULL
FROM history_disposition_candidates c WHERE c.id=h.id AND md5(h.llm_generation_data::text)=c.fingerprint;
  IF EXISTS (SELECT 1 FROM history_disposition_candidates c JOIN experience.chat_history h USING(id)
    WHERE h.llm_generation_data IS NOT NULL)
    THEN RAISE EXCEPTION 'Historical JSON changed during disposition'; END IF;


DROP TABLE history_disposition_written, history_disposition_safe, history_disposition_candidates;
END $batch$;

-- Temporary helpers/manifest live only in this psql session. Each bounded batch commits
-- independently, releasing row locks/WAL pressure instead of retaining 295k rows in one tx.
COMMIT;
SELECT format(
  'BEGIN; SET LOCAL lock_timeout = ''5s''; SET LOCAL statement_timeout = ''60s''; SELECT pg_temp.retirement_disposition_batch(ARRAY(SELECT id FROM history_disposition_manifest ORDER BY id LIMIT 2000 OFFSET %s)); COMMIT;',
  batch_offset)
FROM generate_series(0, (SELECT count(*)::integer-1 FROM history_disposition_manifest), 2000) batch_offset
ORDER BY batch_offset
\gexec
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $complete$ BEGIN
  -- Recheck current parent raw data, including any old-writer drift after the manifest.
  IF EXISTS (SELECT 1 FROM history_disposition_manifest) THEN
    IF EXISTS (SELECT 1 FROM experience.chat_history WHERE llm_generation_data IS NOT NULL) THEN
      RAISE EXCEPTION 'Historical JSON remains after disposition; inspect old writers before retry';
    END IF;
  END IF;
END $complete$;
DROP FUNCTION pg_temp.retirement_disposition_batch(uuid[]);
DROP FUNCTION pg_temp.retirement_safe_metadata(jsonb);
DROP TABLE history_disposition_manifest;
COMMIT;
-- Only full success reaches the workflow ledger step. On failure the current batch rolls
-- back; prior commits remain safe to re-enter. No old-file ledger or claim is rewritten.
-- Recovery retains normalized facts; discarded non-allowlisted diagnostics cannot be restored.
