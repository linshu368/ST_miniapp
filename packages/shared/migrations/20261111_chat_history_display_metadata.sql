-- domain: experience. Rebuildable display values of one immutable history identity/revision.
-- Requires 20261030_chat_generation_dispatch_prepare and 20261102_chat_message_overrides.
-- No business rows scanned. TEST -> production expand -> bounded backfill -> backend.
-- Recovery: stop new readers before reverting the admission patch/invalidation below;
-- preserve history, billing and metadata. See docs/chat-history-read-performance.md.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE IF NOT EXISTS experience.chat_history_display_metadata (
  history_id uuid CONSTRAINT chat_history_display_metadata_pkey PRIMARY KEY,
  request_id text,
  opening_message text,
  projection_version smallint NOT NULL,
  CONSTRAINT chat_history_display_metadata_history_fkey FOREIGN KEY(history_id)
    REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  CONSTRAINT chat_history_display_metadata_version_check CHECK(projection_version IN (0,1))
);
ALTER TABLE experience.chat_history_display_metadata OWNER TO postgres;
ALTER TABLE experience.chat_history_display_metadata ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_history_display_metadata FROM PUBLIC,anon,authenticated,service_role;
-- The existing admission function is SECURITY INVOKER. Keep its security mode;
-- service_role already writes the authoritative history, and needs only these operations.
GRANT SELECT,INSERT,UPDATE ON experience.chat_history_display_metadata TO service_role;
COMMENT ON TABLE experience.chat_history_display_metadata IS
  'Rebuildable exact display strings; version 0 invalid, version 1 includes known NULL. Never billing or request identity authority.';

CREATE OR REPLACE FUNCTION experience.extract_chat_history_display(p_history jsonb)
RETURNS TABLE(request_id text,opening_message text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 WITH head AS MATERIALIZED (
   SELECT p_history->0 AS first, p_history->1 AS second
 ), candidates AS (
   SELECT CASE WHEN first IS NULL OR first='null'::jsonb THEN second ELSE first END AS marker,
     first,second FROM head
 )
 SELECT CASE WHEN jsonb_typeof(marker->'request_id')='string' THEN marker->>'request_id' END,
   (SELECT trimmed FROM (
     SELECT ordinal, btrim(item->>'content',
       U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') AS trimmed
     FROM (VALUES(0,first),(1,second)) parts(ordinal,item)
     WHERE item->>'role'='assistant' AND jsonb_typeof(item->'content')='string'
   ) text_values WHERE trimmed<>'' ORDER BY ordinal LIMIT 1)
 FROM candidates;
$fn$;
ALTER FUNCTION experience.extract_chat_history_display(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.extract_chat_history_display(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION experience.extract_chat_history_display(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION experience.invalidate_chat_history_display()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  -- Never compare or parse OLD/NEW.history: legacy writes only invalidate.
  UPDATE experience.chat_history_display_metadata SET projection_version=0
  WHERE history_id=NEW.id AND projection_version<>0;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION experience.invalidate_chat_history_display() OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.invalidate_chat_history_display() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS trg_invalidate_chat_history_display ON experience.chat_history;
CREATE TRIGGER trg_invalidate_chat_history_display AFTER UPDATE OF history ON experience.chat_history
FOR EACH ROW EXECUTE FUNCTION experience.invalidate_chat_history_display();

-- Patch exact reviewed seams, retaining the current function's OID/security/grants
-- and unrelated upstream behavior. Unknown definitions fail instead of replacing them.
DO $patch$
DECLARE src text; old_write text; new_write text;
BEGIN
 SELECT pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure) INTO src;
 src:=replace(src,E'\r\n',E'\n');
 IF position('chat_display_projection_v1' IN src)>0 THEN RETURN; END IF;
 old_write := $old$    UPDATE experience.chat_history
    SET history=CASE
          -- An idempotent replay of initial admission must not erase an already-frozen prompt.
          WHEN p_input ? 'history' AND (p_input ? 'snapshot' OR h.llm_billing_snapshot IS NULL) THEN v_history
          ELSE history END,
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
    WHERE id=p_history_id;$old$;
 new_write := $new$    -- chat_display_projection_v1
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
    END IF;$new$;
 old_write:=replace(old_write,E'\r\n',E'\n');
 new_write:=replace(new_write,E'\r\n',E'\n');
 IF (length(src)-length(replace(src,old_write,'')))/length(old_write)<>1 THEN
   RAISE EXCEPTION 'admission display patch anchors changed; review current definition';
 END IF;
 EXECUTE replace(src,old_write,new_write);
END;
$patch$;

-- A bounded primitive for reviewed migration batches, not a background worker or GET repair.
-- Each call is one transaction in its calling migration; caller retains skipped ranges.
CREATE OR REPLACE FUNCTION experience.backfill_chat_history_display(p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE h record; n integer:=0;
BEGIN
 IF p_ids IS NULL OR cardinality(p_ids)>100 THEN
   RAISE EXCEPTION 'backfill requires at most 100 explicit IDs' USING ERRCODE='22023';
 END IF;
 FOR h IN SELECT ch.id,ch.history FROM experience.chat_history ch
   WHERE ch.id=ANY(p_ids) AND ch.session_id IS NOT NULL AND ch.turn_index IS NOT NULL AND ch.revision IS NOT NULL
   ORDER BY ch.id FOR UPDATE OF ch SKIP LOCKED
 LOOP
   INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message,projection_version)
   SELECT h.id,d.request_id,d.opening_message,1 FROM experience.extract_chat_history_display(h.history) d
   ON CONFLICT(history_id) DO UPDATE SET request_id=excluded.request_id,
     opening_message=excluded.opening_message,projection_version=1;
   n:=n+1;
 END LOOP;
 RETURN n;
END;
$fn$;
ALTER FUNCTION experience.backfill_chat_history_display(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.backfill_chat_history_display(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION experience.backfill_chat_history_display(uuid[]) IS
  'Operator-only bounded transaction primitive. Explicit reviewed IDs; lock original rows before projection; retry skipped IDs in later reviewed batches.';
NOTIFY pgrst,'reload schema';
COMMIT;
