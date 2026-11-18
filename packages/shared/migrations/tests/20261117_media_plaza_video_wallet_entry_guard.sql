-- Read-only TEST postflight; never create users or debit real wallets.
BEGIN READ ONLY;
DO $verify$
DECLARE
  v_oid OID := to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)');
  v_definition TEXT;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'video_wallet_guard: debit function missing'; END IF;
  v_definition := pg_get_functiondef(v_oid);
  IF strpos(v_definition,
    $allowed$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN$allowed$
  ) = 0 THEN
    RAISE EXCEPTION 'video_wallet_guard: video type missing';
  END IF;
  IF strpos(v_definition, 'v_bonus := LEAST(v_wallet.bonus_credits, v_amount);') = 0 THEN
    RAISE EXCEPTION 'video_wallet_guard: current bonus-first policy missing';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'video_wallet_guard: unexpected debit privileges';
  END IF;
END;
$verify$;
ROLLBACK;
