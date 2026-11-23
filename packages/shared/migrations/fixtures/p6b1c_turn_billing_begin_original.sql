CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  h experience.chat_history%ROWTYPE;
  v_fallback text := COALESCE(p_input->>'fallback_model_id','deepseek/deepseek-v4.1-flash');
  v_charge_id uuid := (p_input->>'charge_id')::uuid;
  v_request_id uuid := (p_input->>'request_id')::uuid;
  v_history jsonb := p_input->'history';
BEGIN
  IF (p_input ? 'fallback_model_id' AND jsonb_typeof(p_input->'fallback_model_id') IS DISTINCT FROM 'string')
     OR length(v_fallback) > 200
     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Invalid frozen fallback model ID' USING ERRCODE='22023';
  END IF;
  IF p_input->>'measurement_method' IS NOT NULL AND p_input->>'measurement_method' <> 'client_committed_v4' THEN
    RAISE EXCEPTION 'Invalid client measurement method' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'charge_id' AND v_charge_id IS NULL THEN
    RAISE EXCEPTION 'Invalid generation charge identity' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'history' THEN
    IF jsonb_typeof(v_history) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid generation history' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(v_history) = 0 OR v_request_id IS NULL
       OR (v_history#>>'{0,request_id}')::uuid IS DISTINCT FROM v_request_id
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_history) AS item
         WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR COALESCE(item->>'role','') NOT IN ('system','user','assistant')
           OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string'
       ) THEN
      RAISE EXCEPTION 'Generation history identity or message shape differs' USING ERRCODE='22023';
    END IF;
  END IF;

  IF p_input ? 'history' AND NOT (p_input ? 'snapshot')
     AND (jsonb_array_length(v_history) <> 1 OR v_history#>>'{0,role}' <> 'system' OR v_history#>>'{0,content}' <> '') THEN
    RAISE EXCEPTION 'Initial generation history must contain only its request marker' USING ERRCODE='22023';
  END IF;

  -- One PK row lock arbitrates admission/freeze against cancellation and terminal writes.
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL
     OR (v_charge_id IS NOT NULL AND h.llm_charge_id IS NOT NULL AND h.llm_charge_id <> v_charge_id)
     OR (p_input ? 'snapshot' AND COALESCE(h.llm_charge_id,v_charge_id)::text IS DISTINCT FROM p_input#>>'{snapshot,charge_id}') THEN
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='PT409';
  END IF;
  IF p_input ? 'history' AND EXISTS (
       SELECT 1 FROM experience.chat_history_display_metadata m
       WHERE m.history_id=p_history_id AND m.request_id IS NOT NULL
         AND m.request_id::uuid IS DISTINCT FROM v_request_id) THEN
    RAISE EXCEPTION 'Stored generation request identity differs' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id)
     AND NOT EXISTS (
       SELECT 1 FROM experience.chat_generation_requests
       WHERE chat_history_id=p_history_id AND client_request_id=v_request_id
         AND (NOT (p_input ? 'fallback_model_id') OR fallback_model_id=v_fallback)
         AND fallback_timeout_ms IS NOT DISTINCT FROM (p_input->>'fallback_timeout_ms')::integer
         AND (p_input->>'measurement_method' IS NULL OR measurement_method=p_input->>'measurement_method')
     ) THEN
    RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
  END IF;

  IF p_input ? 'history' OR v_charge_id IS NOT NULL OR p_input ? 'snapshot' THEN
    -- chat_display_projection_v1
    IF p_input ? 'history' AND (p_input ? 'snapshot' OR h.llm_billing_snapshot IS NULL) THEN
      UPDATE experience.chat_history SET
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
      -- Derive only from the input actually accepted above, never from the stored TOAST value.
      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message)
      SELECT p_history_id,d.request_id,d.opening_message FROM experience.extract_chat_history_display(v_history) d
      WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
      ON CONFLICT(history_id) DO UPDATE SET request_id=excluded.request_id,
        opening_message=excluded.opening_message;
    ELSE
      -- No history assignment: initial replay cannot erase the opening or invalidate its projection.
      UPDATE experience.chat_history SET llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN RETURN; END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms,recoverable_delivery,measurement_method)
  VALUES(p_history_id,v_request_id,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer,COALESCE((p_input->>'recoverable_delivery')::boolean,false),p_input->>'measurement_method');
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$function$
