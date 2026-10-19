-- domain: experience
-- Reviewed disposal policy: retain typed call facts, discard non-allowlisted
-- historical diagnostics (including referers, external users and nested responses).
-- No prompt/reply, wallet, charge, quota or business terminal-state writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE history_disposition_candidates ON COMMIT DROP AS
SELECT h.id,NULL::text AS fingerprint,NULL::text AS detail_fingerprint
FROM experience.chat_history h LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
WHERE h.llm_generation_data IS NOT NULL OR o.llm_generation_data IS NOT NULL
LIMIT 2001;
DO $$ BEGIN
  IF (SELECT count(*) FROM history_disposition_candidates)>2000
    THEN RAISE EXCEPTION 'History disposition exceeds reviewed 2000-row budget'; END IF;
END $$;
-- Do not detoast/hash a production-sized table before enforcing the batch budget.
UPDATE history_disposition_candidates c SET fingerprint=md5(h.llm_generation_data::text),
  detail_fingerprint=md5(o.llm_generation_data::text)
FROM experience.chat_history h LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
WHERE c.id=h.id;
DO $$ BEGIN
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
END $$;

-- Session-local equivalent of openrouter-metadata.ts's diagnostic allowlist.
-- Never stringify unknown values, copy arbitrary error messages or dynamic keys.
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
CREATE TEMP TABLE history_disposition_safe ON COMMIT DROP AS
SELECT c.id,c.detail_fingerprint,
  pg_temp.retirement_safe_metadata(h.llm_generation_data) || pg_temp.retirement_safe_metadata(o.llm_generation_data) AS metadata
FROM history_disposition_candidates c JOIN experience.chat_history h USING(id)
LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
WHERE md5(h.llm_generation_data::text) IS NOT DISTINCT FROM c.fingerprint
  AND md5(o.llm_generation_data::text) IS NOT DISTINCT FROM c.detail_fingerprint;
DO $$ BEGIN
  IF (SELECT count(*) FROM history_disposition_safe)<>(SELECT count(*) FROM history_disposition_candidates)
    THEN RAISE EXCEPTION 'Historical JSON changed during disposition'; END IF;
END $$;

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
FROM history_disposition_safe s WHERE s.id=o.chat_history_id
  AND md5(o.llm_generation_data::text) IS NOT DISTINCT FROM s.detail_fingerprint
RETURNING o.chat_history_id) SELECT chat_history_id FROM written;
DO $$ BEGIN
  IF (SELECT count(*) FROM history_disposition_written)<>(SELECT count(*) FROM history_disposition_safe s
    JOIN experience.openrouter_chat_history o ON o.chat_history_id=s.id)
    THEN RAISE EXCEPTION 'Historical detail changed during disposition'; END IF;
END $$;

-- Venice already owns its details. Do not rewrite its mapper, schema or diagnostics.
-- A missing typed fact needs a separately reviewed provider-specific fix, not loss.
DO $$ BEGIN
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
END $$;
UPDATE experience.chat_history h SET llm_generation_data=NULL
FROM history_disposition_candidates c WHERE c.id=h.id AND md5(h.llm_generation_data::text)=c.fingerprint;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM history_disposition_candidates c JOIN experience.chat_history h USING(id)
    WHERE h.llm_generation_data IS NOT NULL)
    THEN RAISE EXCEPTION 'Historical JSON changed during disposition'; END IF;
END $$;
DROP FUNCTION pg_temp.retirement_safe_metadata(jsonb);
COMMIT;
-- Forward recovery retains normalized call facts. Discarded non-allowlisted
-- historical diagnostics are intentionally irrecoverable here; no raw archive.
