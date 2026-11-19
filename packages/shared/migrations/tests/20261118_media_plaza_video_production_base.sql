-- Catalog-only production postflight: no users, debit, refund or share is created.
BEGIN READ ONLY;
DO $verify$
DECLARE v_table REGCLASS; v_rpc OID; v_count INTEGER := 0; v_wallet TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['media_plaza.video_quotes'::regclass,
    'media_plaza.video_attempts'::regclass,'media_plaza.video_artifacts'::regclass] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=v_table)
       OR has_table_privilege('anon',v_table,'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated',v_table,'SELECT,INSERT,UPDATE,DELETE')
       OR NOT has_table_privilege('service_role',v_table,'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'video_prod_base_verify: table security differs';
    END IF;
  END LOOP;
  FOR v_rpc IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='billing' AND p.proname IN ('reserve_media_plaza_video','refund_media_plaza_video','share_media_plaza_video'))
      OR (n.nspname='media_plaza' AND p.proname IN ('claim_video_submit_jobs','claim_video_poll_jobs','publish_video_artifact','import_video_seed_work')) LOOP
    v_count := v_count+1;
    IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid=v_rpc)
       OR has_function_privilege('anon',v_rpc,'EXECUTE')
       OR has_function_privilege('authenticated',v_rpc,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_rpc,'EXECUTE') THEN
      RAISE EXCEPTION 'video_prod_base_verify: RPC security differs';
    END IF;
  END LOOP;
  SELECT pg_get_functiondef('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure)
    INTO v_wallet;
  IF v_count<>7
     OR strpos(v_wallet,$guard$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN$guard$)=0
     OR strpos(v_wallet,'v_bonus := LEAST(v_wallet.bonus_credits, v_amount);')=0
     OR has_function_privilege('anon','billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role','billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'video_prod_base_verify: wallet or RPC count differs';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='billing.wallet_ledger'::regclass
      AND conname='wallet_ledger_entry_type_check' AND NOT convalidated
      AND strpos(pg_get_constraintdef(oid),'creator_reward')>0
      AND strpos(pg_get_constraintdef(oid),'survey_reward')>0
      AND strpos(pg_get_constraintdef(oid),'media_plaza_video_reserve')>0
      AND strpos(pg_get_constraintdef(oid),'media_plaza_video_refund')>0)
     OR NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='media_plaza.image_plaza_works'::regclass
      AND conname='image_plaza_works_image_origin_shape_check' AND convalidated)
     OR strpos(pg_get_functiondef('billing.share_media_plaza_video(uuid,uuid,text,text,text,text[],numeric)'::regprocedure),
      'image_plaza_first_share_completed_at')>0 THEN
    RAISE EXCEPTION 'video_prod_base_verify: compatibility contract differs';
  END IF;
END;
$verify$;
ROLLBACK;
