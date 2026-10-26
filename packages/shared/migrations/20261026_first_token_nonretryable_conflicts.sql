-- domain: experience
-- Permanent lifecycle/identity conflicts must not use serialization_failure (40001).
-- PostgREST 14 retries 40001 internally, even after the HTTP client has given up.
-- Preserve each installed function's current body/signature/security/ACL; only change
-- its explicit business-conflict SQLSTATE to PT409 (one HTTP 409, no retry loop).
-- No business rows, schema shape, pricing or quota policy changes. TEST first.
-- Recovery: transaction rollback before commit; forward-fix after commit. Never
-- restore 40001 for a permanent rejection, which would restart the production storm.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE
  v_signature text;
  v_oid regprocedure;
  v_definition text;
  v_updated text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'experience.begin_chat_generation_observation(uuid,jsonb)',
    'experience.prepare_chat_generation_fallback(uuid,uuid,numeric)',
    'experience.select_chat_generation_delivery(uuid,uuid,text)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'Missing first-token function: %',v_signature;
    END IF;
    v_definition := pg_get_functiondef(v_oid);
    v_updated := regexp_replace(v_definition,'ERRCODE[[:space:]]*=[[:space:]]*''40001''','ERRCODE=''PT409''','gi');
    IF v_updated = v_definition AND v_definition !~ 'PT409' THEN
      RAISE EXCEPTION 'Unexpected conflict contract: %',v_signature;
    END IF;
    IF v_updated <> v_definition THEN EXECUTE v_updated; END IF;
    IF to_regprocedure(v_signature) IS DISTINCT FROM v_oid
       OR pg_get_functiondef(v_oid) ~ 'ERRCODE[[:space:]]*=[[:space:]]*''40001''' THEN
      RAISE EXCEPTION 'Conflict patch validation failed: %',v_signature;
    END IF;
  END LOOP;
END;
$migration$;
COMMIT;
