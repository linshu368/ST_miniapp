-- domain: experience
-- First ready attempt may win after fallback starts; the existing winner CAS and
-- original charge identity remain authoritative. Loser fragments are diagnostic only.
-- No new table/index/job, backfill, per-token write or billing function change.
-- TEST first. Deploy this migration before the racing backend. Old writers remain
-- compatible. Roll back application only; retain diagnostics and narrowed reader ACL.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE experience.chat_generation_attempts
 ADD COLUMN IF NOT EXISTS discarded_response jsonb;
-- The new nullable column is NULL for every old row. NOT VALID avoids a locked
-- historical scan while PostgreSQL still checks every new INSERT/UPDATE.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='experience.chat_generation_attempts'::regclass
   AND conname='chat_generation_attempt_discarded_response_check') THEN
 ALTER TABLE experience.chat_generation_attempts
 ADD CONSTRAINT chat_generation_attempt_discarded_response_check CHECK (
  discarded_response IS NULL OR (
   jsonb_typeof(discarded_response)='object'
   AND discarded_response ?& ARRAY['reason','content','reasoning','truncated']
   AND discarded_response-ARRAY['reason','content','reasoning','truncated']='{}'::jsonb
   AND jsonb_typeof(discarded_response->'reason')='string'
   AND discarded_response->>'reason'='race_lost'
   AND jsonb_typeof(discarded_response->'content')='string'
   AND jsonb_typeof(discarded_response->'reasoning')='string'
   AND jsonb_typeof(discarded_response->'truncated')='boolean'
   AND length(discarded_response->>'content')<=2048
   AND length(discarded_response->>'reasoning')<=2048
  )
 ) NOT VALID;
 END IF;
END $$;
COMMENT ON COLUMN experience.chat_generation_attempts.discarded_response IS
 'First bounded loser snapshot: already received body/public reasoning, max 2048 chars each. Not delivered, billed, used as context, or exposed to metrics readers.';
COMMENT ON COLUMN experience.chat_generation_requests.fallback_timeout_ms IS
 'Frozen configuration: racing backend uses this as fallback reserved time when scheduling dispatch; both attempts share the total first-token deadline. Earlier backends used it as a fallback POST-to-token limit; historical values keep that meaning.';

CREATE OR REPLACE FUNCTION experience.prepare_chat_generation_fallback(p_history_id uuid,p_attempt_id uuid,p_triggered_ms numeric)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE; existing_id uuid;
BEGIN
  -- Keep the established lock order. This RPC records a scheduled attempt,
  -- never permission to call a model. Slow storage may trail the winner
  -- or cancellation, so preserve facts without reopening delivery or billing.
  PERFORM 1 FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  IF p_attempt_id IS NULL OR p_triggered_ms IS NULL OR p_triggered_ms<0
     OR p_triggered_ms>=r.first_token_deadline_ms THEN
    RAISE EXCEPTION 'Fallback dispatch was outside the frozen first-token budget' USING ERRCODE='22023';
  END IF;
  SELECT id INTO existing_id FROM experience.chat_generation_attempts WHERE chat_history_id=p_history_id AND role='fallback';
  IF existing_id IS NOT NULL THEN
    IF existing_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Fallback attempt identity conflict' USING ERRCODE='PT409';
  END IF;
  UPDATE experience.chat_generation_requests SET fallback_triggered_ms=COALESCE(fallback_triggered_ms,p_triggered_ms) WHERE chat_history_id=p_history_id;
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES(p_attempt_id,p_history_id,'fallback','openrouter',r.fallback_model_id);
END;
$$;

CREATE OR REPLACE FUNCTION experience.observe_chat_generation_attempt(p_history_id uuid,p_observation jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a experience.chat_generation_attempts%ROWTYPE; v_discarded jsonb; v_input jsonb;
BEGIN
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=(p_observation->>'id')::uuid AND chat_history_id=p_history_id FOR UPDATE;
  IF a.provider IS DISTINCT FROM p_observation->>'provider' OR a.provider_model_id IS DISTINCT FROM p_observation->>'model' OR a.role IS DISTINCT FROM p_observation->>'role' THEN
    RAISE EXCEPTION 'Attempt route cannot be rebound' USING ERRCODE='22023';
  END IF;
  IF a.generation_id IS NOT NULL AND p_observation->>'generation_id' IS NOT NULL AND a.generation_id <> p_observation->>'generation_id' THEN
    RAISE EXCEPTION 'Attempt generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- A stopped loser is terminal. Replayed/later snapshots cannot overwrite or
  -- enlarge its diagnostic payload, and duplicate reports cause no UPDATE.
  IF a.discarded_response IS NOT NULL THEN RETURN; END IF;
  IF p_observation ? 'discarded_response' THEN
    v_input:=p_observation->'discarded_response';
    IF jsonb_typeof(v_input) IS DISTINCT FROM 'object'
       OR v_input->>'reason' IS DISTINCT FROM 'race_lost'
       OR jsonb_typeof(v_input->'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_input->'reasoning') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_input->'truncated') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid discarded attempt snapshot' USING ERRCODE='22023';
    END IF;
    -- Rebuild an explicit allowlist; never persist arbitrary provider objects.
    v_discarded:=jsonb_build_object('reason','race_lost',
      'content',left(v_input->>'content',2048),'reasoning',left(v_input->>'reasoning',2048),
      'truncated',(v_input->>'truncated')::boolean OR length(v_input->>'content')>2048 OR length(v_input->>'reasoning')>2048);
  END IF;
  UPDATE experience.chat_generation_attempts SET
    generation_id=COALESCE(generation_id,p_observation->>'generation_id'),
    dispatched_at=COALESCE(dispatched_at,(p_observation->>'dispatched_at')::timestamptz),
    dispatch_offset_ms=COALESCE(dispatch_offset_ms,(p_observation->>'dispatch_offset_ms')::numeric),
    headers_ms=COALESCE(headers_ms,(p_observation->>'headers_ms')::numeric),
    first_chunk_ms=COALESCE(first_chunk_ms,(p_observation->>'first_chunk_ms')::numeric),
    first_token_ms=COALESCE(first_token_ms,(p_observation->>'first_token_ms')::numeric),
    observed_until_ms=GREATEST(observed_until_ms,(p_observation->>'observed_until_ms')::numeric),
    http_status=COALESCE(http_status,(p_observation->>'http_status')::integer),
    end_reason=CASE WHEN v_discarded IS NOT NULL THEN 'cancelled' ELSE COALESCE(end_reason,p_observation->>'end_reason') END,
    discarded_response=v_discarded,
    provider_latency_ms=COALESCE(provider_latency_ms,(p_observation->>'provider_latency_ms')::numeric),
    provider_name=COALESCE(provider_name,left(p_observation->>'provider_name',512)),
    provider_reported_model=COALESCE(provider_reported_model,left(p_observation->>'provider_reported_model',512)),
    finish_reason=COALESCE(finish_reason,left(p_observation->>'finish_reason',128)),updated_at=clock_timestamp()
  WHERE id=a.id;
END;
$$;

DO $$
DECLARE d text; old text;
BEGIN
  SELECT pg_get_functiondef('experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure) INTO d;
  old := $patch$  IF r.fallback_triggered_ms IS NOT NULL AND a.role <> 'fallback' THEN
    RAISE EXCEPTION 'Primary cannot reclaim delivery after fallback' USING ERRCODE='PT409';
  END IF;$patch$;
  IF position('Primary cannot reclaim delivery after fallback' IN d)>0 THEN
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected delivery selection guard'; END IF;
    d:=replace(d,old,'  -- Either attempt may win; the immutable delivery_attempt_id below arbitrates once.');
    EXECUTE d;
  END IF;
  IF position('IF r.delivery_attempt_id IS NOT NULL' IN d)=0
     OR position('PT409' IN d)=0 OR position('40001' IN d)>0 THEN
    RAISE EXCEPTION 'Delivery winner CAS or terminal conflict contract missing';
  END IF;
END;
$$;

-- A table-level metrics grant would automatically expose the new content column.
-- Keep only the pre-existing scalar columns; security-invoker facts remain usable.
REVOKE SELECT ON experience.chat_generation_attempts FROM first_token_metrics_reader;
REVOKE SELECT(discarded_response) ON experience.chat_generation_attempts FROM first_token_metrics_reader;
GRANT SELECT(id,chat_history_id,role,provider,provider_model_id,generation_id,
 dispatched_at,dispatch_offset_ms,headers_ms,first_chunk_ms,first_token_ms,
 observed_until_ms,http_status,end_reason,provider_latency_ms,provider_latency_scope,
 provider_name,provider_reported_model,finish_reason,updated_at)
 ON experience.chat_generation_attempts TO first_token_metrics_reader;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['first_token_metrics_reader','grafana_cloud','anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name)
       AND has_column_privilege(role_name,'experience.chat_generation_attempts','discarded_response','SELECT') THEN
      RAISE EXCEPTION 'Unexpected discarded content reader: %',role_name;
    END IF;
  END LOOP;
  IF has_function_privilege('anon','experience.observe_chat_generation_attempt(uuid,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','experience.select_chat_generation_delivery(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','experience.prepare_chat_generation_fallback(uuid,uuid,numeric)','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected public attempt writer privilege';
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
