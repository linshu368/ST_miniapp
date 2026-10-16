-- domain: experience
-- Local delivery only. Execute one file at a time after the release checklist gates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Same objects/owners/ACL/security modes; only the 12 call-fact expressions change.
DO $$
DECLARE a record; projection text=''; expression text; names jsonb=jsonb_build_object('llm_provider_name','provider_name', 'llm_usage','usage', 'llm_usage_cache','usage_cache', 'llm_native_tokens_cached','native_tokens_cached', 'llm_native_tokens_reasoning','native_tokens_reasoning', 'llm_native_tokens_completion','native_tokens_completion', 'llm_native_tokens_prompt','native_tokens_prompt', 'llm_latency','latency', 'llm_generation_time','generation_time', 'llm_model','model', 'llm_generation_id','llm_generation_id', 'llm_generation_data','llm_generation_data');
BEGIN
  IF EXISTS (SELECT 1 FROM experience.venice_chat_history v JOIN experience.openrouter_chat_history o USING(chat_history_id))
    THEN RAISE EXCEPTION 'Provider overlap; stop view switch'; END IF;
  FOR a IN SELECT attname,format_type(atttypid,atttypmod) typ FROM pg_attribute
    WHERE attrelid='experience.current_chat_history'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum
  LOOP
    IF names ? a.attname THEN
      expression=format('CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.%I WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.%I ELSE NULL END::%s AS %I',a.attname,names->>a.attname,a.typ,a.attname);
    ELSE
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='experience.chat_history'::regclass AND attname=a.attname AND NOT attisdropped)
        THEN RAISE EXCEPTION 'Unexpected current view column'; END IF;
      expression=format('h.%I',a.attname);
    END IF;
    projection=projection || CASE WHEN projection='' THEN '' ELSE ',' END || expression;
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW experience.current_chat_history AS SELECT DISTINCT ON(h.session_id,h.turn_index) ' || projection ||
    ' FROM experience.chat_history h LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL ORDER BY h.session_id,h.turn_index,h.revision DESC';
  IF to_regclass('miniapp_analytics.base_chat_bj') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE VIEW miniapp_analytics.base_chat_bj AS SELECT h.id,h.user_id,h.character_id,h.status,h.created_at,(h.created_at AT TIME ZONE ''Asia/Shanghai'') AS msg_ts_bj,((h.created_at AT TIME ZONE ''Asia/Shanghai''))::date AS msg_date_bj,CASE WHEN v.chat_history_id IS NOT NULL AND o.chat_history_id IS NULL THEN v.llm_latency WHEN o.chat_history_id IS NOT NULL AND v.chat_history_id IS NULL THEN o.latency ELSE NULL END::numeric AS llm_latency FROM experience.chat_history h LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id';
  END IF;
  -- Invoker views require access to exactly their projected columns and join key.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cs_persona_reader') THEN
    IF has_table_privilege('cs_persona_reader','experience.current_chat_history','SELECT') THEN
      GRANT SELECT (chat_history_id,provider_name,usage,usage_cache,native_tokens_cached,native_tokens_reasoning,native_tokens_completion,native_tokens_prompt,latency,generation_time,model,llm_generation_id,llm_generation_data) ON experience.openrouter_chat_history TO cs_persona_reader;
    END IF;
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
-- Recovery: keep provider-backed views with the compatible Backend; do not revert to legacy writers.
