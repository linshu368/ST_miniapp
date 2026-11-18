-- domain: billing
-- Restore the video debit type overwritten by the later bonus-first wallet migration.
-- Preserve the current wallet body, split policy, OID and privileges; no financial rows change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  v_oid OID := to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)');
  v_before RECORD;
  v_after RECORD;
  v_definition TEXT;
  v_expected_body TEXT;
  v_old CONSTANT TEXT := $old$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation') THEN$old$;
  v_new CONSTANT TEXT := $new$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN$new$;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'video_wallet_guard: wallet debit function missing';
  END IF;
  SELECT proowner, proacl, proconfig, prosecdef, provolatile, proparallel,
    proisstrict, proleakproof, procost, prorows, prosrc
  INTO v_before FROM pg_proc WHERE oid = v_oid;
  IF NOT v_before.prosecdef OR v_before.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'video_wallet_guard: unexpected wallet security';
  END IF;

  v_definition := pg_get_functiondef(v_oid);
  -- Only the known guard may change; never replace the current helper with an old full definition.
  IF length(v_definition) - length(replace(v_definition, v_old, '')) = length(v_old)
     AND strpos(v_definition, v_new) = 0 THEN
    v_expected_body := replace(v_before.prosrc, v_old, v_new);
    EXECUTE replace(v_definition, v_old, v_new);
  ELSIF length(v_definition) - length(replace(v_definition, v_new, '')) = length(v_new)
     AND strpos(v_definition, v_old) = 0 THEN
    v_expected_body := v_before.prosrc;
  ELSE
    RAISE EXCEPTION 'video_wallet_guard: unknown or duplicate entry guard';
  END IF;

  IF to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)')::OID IS DISTINCT FROM v_oid THEN
    RAISE EXCEPTION 'video_wallet_guard: function identity changed';
  END IF;
  SELECT proowner, proacl, proconfig, prosecdef, provolatile, proparallel,
    proisstrict, proleakproof, procost, prorows, prosrc
  INTO v_after FROM pg_proc WHERE oid = v_oid;
  IF v_after.prosrc IS DISTINCT FROM v_expected_body
     OR (to_jsonb(v_after) - 'prosrc') IS DISTINCT FROM (to_jsonb(v_before) - 'prosrc') THEN
    RAISE EXCEPTION 'video_wallet_guard: wallet body or attributes changed';
  END IF;
END;
$guard$;

COMMIT;
