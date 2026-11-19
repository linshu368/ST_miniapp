-- Read-only postflight. Inspect catalog only; no business content or synthetic writes.
DO $$
DECLARE
  v_definition text;
  v_validated boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), convalidated INTO v_definition, v_validated
  FROM pg_constraint
  WHERE conrelid = 'media_plaza.image_plaza_messages'::regclass
    AND conname = 'image_plaza_messages_content_check' AND contype = 'c';
  IF v_validated IS DISTINCT FROM true OR lower(regexp_replace(v_definition, '\s', '', 'g'))
     IS DISTINCT FROM 'check(((char_length(trim(bothfromcontent))>=1)and(char_length(trim(bothfromcontent))<=5000)))' THEN
    RAISE EXCEPTION 'image_plaza_message_prompt_5000: postflight constraint mismatch';
  END IF;
  IF NOT has_table_privilege('service_role', 'media_plaza.image_plaza_messages', 'INSERT')
     OR NOT has_table_privilege('service_role', 'media_plaza.image_plaza_messages', 'SELECT') THEN
    RAISE EXCEPTION 'image_plaza_message_prompt_5000: postflight service privileges missing';
  END IF;
END;
$$;
