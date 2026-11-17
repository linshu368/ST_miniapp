-- domain: experience. MANUAL recovery only, after all consumers use the old backend.
-- Stop backfill first. Not a forward schema migration. Preserve prompts, billing,
-- observations and projection values. Unknown admission definitions abort safely.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Exclude concurrent legacy/admission writers across removal + invalidation.
LOCK TABLE experience.chat_history IN SHARE ROW EXCLUSIVE MODE;
DO $undo$
DECLARE src text; patched text; original text;
BEGIN
 SELECT pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure) INTO src;
 src:=replace(src,E'\r\n',E'\n');
 patched := $patched$    -- chat_display_projection_v1
    IF p_input ? 'history' AND (p_input ? 'snapshot' OR h.llm_billing_snapshot IS NULL) THEN
      UPDATE experience.chat_history SET history=v_history,
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
      -- Derive only from the input actually accepted above, never from the stored TOAST value.
      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message,projection_version)
      SELECT p_history_id,d.request_id,d.opening_message,1 FROM experience.extract_chat_history_display(v_history) d
      WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
      ON CONFLICT(history_id) DO UPDATE SET request_id=excluded.request_id,
        opening_message=excluded.opening_message,projection_version=1;
    ELSE
      -- No history assignment: initial replay cannot erase the opening or invalidate its projection.
      UPDATE experience.chat_history SET llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
    END IF;$patched$;
 original := $original$    UPDATE experience.chat_history
    SET history=CASE
          -- An idempotent replay of initial admission must not erase an already-frozen prompt.
          WHEN p_input ? 'history' AND (p_input ? 'snapshot' OR h.llm_billing_snapshot IS NULL) THEN v_history
          ELSE history END,
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
    WHERE id=p_history_id;$original$;
 patched:=replace(patched,E'\r\n',E'\n');
 original:=replace(original,E'\r\n',E'\n');
 IF position('chat_display_projection_v1' IN src)>0 THEN
   IF (length(src)-length(replace(src,patched,'')))/length(patched)<>1 THEN RAISE EXCEPTION 'display recovery anchor changed; inspect current admission'; END IF;
   EXECUTE replace(src,patched,original);
 END IF;
END;
$undo$;
DROP TRIGGER IF EXISTS trg_invalidate_chat_history_display ON experience.chat_history;
-- No consumer may trust now-unmaintained projections. Timeout rolls this entire
-- recovery back; large-table capacity must be checked before scheduling recovery.
UPDATE experience.chat_history_display_metadata SET projection_version=0 WHERE projection_version<>0;
REVOKE SELECT ON experience.chat_history_display,experience.session_chat_display FROM service_role;
REVOKE EXECUTE ON FUNCTION experience.list_chat_message_page(uuid,uuid,integer,integer) FROM service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
