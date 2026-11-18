-- domain: media_plaza
-- E message content: video submit shares this storage; image API remains capped at 2000.
-- Manual workflow: TEST then production, before publishing the 5000-character consumers.
-- Rollback consumers first; retain this wider CHECK while long messages exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE media_plaza.image_plaza_messages IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE
  v_definition text;
  v_validated boolean;
  v_expected text := 'CHECK (((char_length(TRIM(BOTH FROM content)) >= 1) AND (char_length(TRIM(BOTH FROM content)) <= 2000)))';
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated INTO v_definition, v_validated
  FROM pg_constraint
  WHERE conrelid = 'media_plaza.image_plaza_messages'::regclass
    AND conname = 'image_plaza_messages_content_check' AND contype = 'c';
  v_definition := lower(regexp_replace(v_definition, '\s', '', 'g'));
  v_expected := lower(regexp_replace(v_expected, '\s', '', 'g'));
  IF v_definition IS NULL OR v_validated IS DISTINCT FROM true
     OR v_definition NOT IN (v_expected, replace(v_expected, '2000', '5000')) THEN
    RAISE EXCEPTION 'image_plaza_message_prompt_5000: unexpected content constraint';
  END IF;
  IF v_definition = replace(v_expected, '2000', '5000') THEN
    RETURN;
  END IF;
  ALTER TABLE media_plaza.image_plaza_messages DROP CONSTRAINT image_plaza_messages_content_check;
  ALTER TABLE media_plaza.image_plaza_messages ADD CONSTRAINT image_plaza_messages_content_check
    CHECK (char_length(trim(content)) >= 1 AND char_length(trim(content)) <= 5000) NOT VALID;
  ALTER TABLE media_plaza.image_plaza_messages VALIDATE CONSTRAINT image_plaza_messages_content_check;
END;
$$;
COMMIT;
