-- Read-only config/catalog postflight; does not publish config or create drafts.
BEGIN READ ONLY;
DO $verify$
DECLARE v_table REGCLASS;
BEGIN
  IF NOT admin.is_managed_config_key('image_plaza_video_model_catalog')
     OR admin.is_managed_config_key(NULL) IS NOT NULL
     OR to_regprocedure('admin.is_managed_config_key_before_media_plaza_video(text)') IS NOT NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_media_plaza_video(text,jsonb,text)') IS NOT NULL
     OR has_function_privilege('anon','admin.validate_image_plaza_video_model_catalog(jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','admin.validate_image_plaza_video_model_catalog(jsonb)','EXECUTE')
     OR has_function_privilege('service_role','admin.validate_image_plaza_video_model_catalog(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'video_prod_config_verify: registration or security differs';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['admin.config_drafts'::regclass,'admin.config_releases'::regclass] LOOP
    IF NOT EXISTS (SELECT FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='config_key'
      WHERE c.conrelid=v_table AND c.contype='f' AND c.convalidated
        AND c.confrelid='admin.managed_config_keys'::regclass AND c.conkey=ARRAY[a.attnum]) THEN
      RAISE EXCEPTION 'video_prod_config_verify: config-key FK missing';
    END IF;
  END LOOP;
END;
$verify$;
ROLLBACK;
