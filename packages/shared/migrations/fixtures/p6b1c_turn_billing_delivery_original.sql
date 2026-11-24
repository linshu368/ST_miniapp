CREATE OR REPLACE FUNCTION experience.select_chat_generation_delivery(p_history_id uuid, p_attempt_id uuid, p_generation_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE h experience.chat_history%ROWTYPE; r experience.chat_generation_requests%ROWTYPE; a experience.chat_generation_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT r FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id FOR UPDATE;
  SELECT * INTO STRICT a FROM experience.chat_generation_attempts WHERE id=p_attempt_id AND chat_history_id=p_history_id FOR UPDATE;
  -- Either attempt may win; the immutable delivery_attempt_id below arbitrates once.
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  IF r.delivery_attempt_id IS NOT NULL THEN
    IF r.delivery_attempt_id=p_attempt_id THEN RETURN; END IF;
    RAISE EXCEPTION 'Delivery already belongs to another attempt' USING ERRCODE='PT409';
  END IF;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL OR h.llm_charge_id IS NULL
     -- db reorg 6b-1c: the accepted quote lives in billing.usage_charges.
     OR (SELECT u.quote->'snapshot'->>'charge_id' FROM billing.usage_charges u WHERE u.id=h.llm_charge_id)
        IS DISTINCT FROM h.llm_charge_id::text THEN
    RAISE EXCEPTION 'Cancelled/ended generation cannot choose delivery' USING ERRCODE='PT409';
  END IF;
  IF a.generation_id IS NOT NULL AND p_generation_id IS NOT NULL AND a.generation_id <> p_generation_id THEN
    RAISE EXCEPTION 'Delivery generation identity conflict' USING ERRCODE='22023';
  END IF;
  -- db reorg 6a-2c-1: the delivered attempt is the only call identity; OpenRouter / Venice
  -- metadata lives in ops.llm_calls, written by experience.record_llm_call_metadata.
  IF a.provider='surplus' THEN
    -- Losing Surplus attempts may coexist with an OpenRouter winner; only this RPC
    -- chooses billing/delivery ownership. The call table never changes the parent.
    PERFORM experience.record_surplusintelligence_call(p_history_id,jsonb_build_object('generation_id',COALESCE(p_generation_id,a.generation_id)));
  ELSIF a.provider NOT IN ('openrouter','venice') THEN
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
  END IF;
  -- The entire quote stays intact; only these two routing fields are bound to delivery.
  UPDATE experience.chat_history SET llm_billing_snapshot=llm_billing_snapshot || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id) WHERE id=p_history_id;
  UPDATE experience.chat_generation_attempts SET generation_id=COALESCE(generation_id,p_generation_id) WHERE id=p_attempt_id;
  UPDATE experience.chat_generation_requests SET delivery_attempt_id=p_attempt_id WHERE chat_history_id=p_history_id;
END;
$function$
