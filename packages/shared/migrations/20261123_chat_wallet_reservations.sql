-- domain: billing
-- Expand only; no historical reservation/back-charge. Deploy backend error handling
-- before enabling this migration. Rollback is forward-fix: never discard live holds.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('billing.usage_charges_reserved_user_idx') AND indisvalid AND indisready) THEN
    RAISE EXCEPTION 'Apply chat wallet reservation columns/index first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION billing.protect_chat_reserved_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_main numeric; v_bonus numeric;
BEGIN
  IF NEW.main_credits>=OLD.main_credits AND NEW.bonus_credits>=OLD.bonus_credits THEN RETURN NEW; END IF;
  -- Defence in depth for existing consumers that still write a wallet directly.
  -- The canonical debit consumes its own reservation before this UPDATE.
  SELECT COALESCE(sum(reserved_main_credits),0),COALESCE(sum(reserved_bonus_credits),0)
    INTO v_main,v_bonus FROM billing.usage_charges WHERE user_id=NEW.user_id
      AND (reserved_main_credits>0 OR reserved_bonus_credits>0);
  IF NEW.main_credits<v_main OR NEW.bonus_credits<v_bonus THEN
    RAISE EXCEPTION 'TOTAL_CREDITS_INSUFFICIENT' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_chat_reserved_balance ON billing.user_wallets;
CREATE TRIGGER protect_chat_reserved_balance BEFORE UPDATE OF main_credits,bonus_credits
  ON billing.user_wallets FOR EACH ROW EXECUTE FUNCTION billing.protect_chat_reserved_balance();

CREATE OR REPLACE FUNCTION billing.reserve_chat_charge(p_history_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  c billing.usage_charges; w billing.user_wallets;
  v_amount numeric; v_policy text; v_main numeric; v_bonus numeric;
BEGIN
  SELECT u.* INTO STRICT c FROM billing.usage_charges u
    JOIN experience.chat_history h ON h.llm_charge_id=u.id
    WHERE h.id=p_history_id AND u.kind='chat_text' AND u.subject_id=h.id;
  v_amount := COALESCE((c.quote#>>'{snapshot,payable_credits}')::numeric,
    (c.quote#>>'{snapshot,fixed_deduction}')::numeric);
  v_policy := c.quote#>>'{snapshot,wallet_policy}';
  IF v_amount IS NULL OR v_amount < 0 OR v_amount <> trunc(v_amount)
     OR v_policy IS NULL OR v_policy NOT IN ('main_only','main_then_bonus') THEN
    RAISE EXCEPTION 'Invalid chat reservation quote' USING ERRCODE='22023';
  END IF;
  IF c.settled_at IS NOT NULL OR c.status NOT IN ('quoted','pending') THEN
    RAISE EXCEPTION 'Chat reservation is no longer open' USING ERRCODE='PT409';
  END IF;
  IF c.reserved_main_credits+c.reserved_bonus_credits > 0 THEN
    IF c.reserved_main_credits+c.reserved_bonus_credits <> v_amount THEN
      RAISE EXCEPTION 'Chat reservation quote differs' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  IF v_amount=0 THEN RETURN; END IF;
  -- All admission and consumption arbitrate through the same wallet row lock.
  SELECT * INTO STRICT w FROM billing.user_wallets WHERE user_id=c.user_id FOR UPDATE;
  SELECT w.main_credits-COALESCE(sum(u.reserved_main_credits),0),
         w.bonus_credits-COALESCE(sum(u.reserved_bonus_credits),0)
    INTO v_main,v_bonus FROM billing.usage_charges u WHERE u.user_id=c.user_id
      AND (u.reserved_main_credits>0 OR u.reserved_bonus_credits>0);
  IF v_policy='main_only' THEN
    IF v_main<v_amount THEN
      RAISE EXCEPTION 'MAIN_CREDITS_INSUFFICIENT' USING ERRCODE='P0001',
        DETAIL=json_build_object('credits_required',v_amount,'credits_available',greatest(v_main,0))::text;
    END IF;
    v_main:=v_amount; v_bonus:=0;
  ELSE
    IF v_main+v_bonus<v_amount THEN
      RAISE EXCEPTION 'TOTAL_CREDITS_INSUFFICIENT' USING ERRCODE='P0001',
        DETAIL=json_build_object('credits_required',v_amount,'credits_available',greatest(v_main+v_bonus,0))::text;
    END IF;
    v_bonus:=least(v_bonus,v_amount); v_main:=v_amount-v_bonus;
  END IF;
  UPDATE billing.usage_charges SET reserved_main_credits=v_main,reserved_bonus_credits=v_bonus
    WHERE id=c.id;
END $$;

CREATE OR REPLACE FUNCTION billing.guard_chat_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.reserved_main_credits+OLD.reserved_bonus_credits>0
     AND ((NEW.quote->'snapshot') - ARRAY['provider','provider_model_id'])
       IS DISTINCT FROM ((OLD.quote->'snapshot') - ARRAY['provider','provider_model_id']) THEN
    RAISE EXCEPTION 'Reserved chat quote is immutable' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' AND OLD.kind='chat_text' AND OLD.status='failed' AND OLD.settled_at IS NOT NULL THEN
    NEW.status:='failed'; NEW.settled_at:=OLD.settled_at; NEW.charged_credits:=OLD.charged_credits;
  END IF;
  IF NEW.settled_at IS NOT NULL OR NEW.status NOT IN ('quoted','pending','reserved') THEN
    NEW.reserved_main_credits:=0; NEW.reserved_bonus_credits:=0;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_chat_reservation ON billing.usage_charges;
CREATE TRIGGER guard_chat_reservation BEFORE INSERT OR UPDATE ON billing.usage_charges
  FOR EACH ROW EXECUTE FUNCTION billing.guard_chat_reservation();

CREATE OR REPLACE FUNCTION billing.release_failed_chat_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- Timeout recovery and a pre-dispatch failure are definitively non-billable.
  -- User stops and successful replies retain their hold until the billing gate settles.
  IF NEW.status='upstream_error' OR NEW.llm_finish_reason='timeout'
     OR (OLD.llm_charge_id IS NOT NULL AND NEW.llm_charge_id IS NULL) THEN
    UPDATE billing.usage_charges SET reserved_main_credits=0,reserved_bonus_credits=0
      WHERE id=COALESCE(NEW.llm_charge_id,OLD.llm_charge_id)
        AND (reserved_main_credits>0 OR reserved_bonus_credits>0);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS release_failed_chat_reservation ON experience.chat_history;
CREATE TRIGGER release_failed_chat_reservation AFTER UPDATE OF status,llm_finish_reason,llm_charge_id
  ON experience.chat_history FOR EACH ROW EXECUTE FUNCTION billing.release_failed_chat_reservation();

CREATE OR REPLACE FUNCTION billing.fail_chat_charge_for_balance(p_charge_id uuid,p_error_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_error_code NOT IN ('MAIN_CREDITS_INSUFFICIENT','TOTAL_CREDITS_INSUFFICIENT') THEN
    RAISE EXCEPTION 'Invalid balance rejection code' USING ERRCODE='22023';
  END IF;
  -- A rejected debit has rolled back. Permanently close only its still-unsettled
  -- quote; never convert a concurrently successful debit into a free/failed bill.
  UPDATE billing.usage_charges SET status='failed',settled_at=now(),
    reserved_main_credits=0,reserved_bonus_credits=0,updated_at=now()
    WHERE id=p_charge_id AND kind='chat_text' AND settled_at IS NULL
      AND status IN ('quoted','pending','partial');
END $$;

-- Preserve current function attributes/owners/ACLs; require each known anchor once.
DO $patch$
DECLARE f text; old text; replacement text; signature text;
BEGIN
  f:=pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure);
  old:='  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN RETURN; END IF;';
  replacement:=E'  -- chat-wallet-reservation-v1\n  IF p_input ? ''snapshot'' THEN PERFORM billing.reserve_chat_charge(p_history_id); END IF;\n'||old;
  IF strpos(f,'chat-wallet-reservation-v1')=0 THEN
    IF (length(f)-length(replace(f,old,'')))/length(old)<>1
       OR strpos(f,'billing.save_chat_turn_quote')=0 THEN RAISE EXCEPTION 'Unknown generation admission shape'; END IF;
    EXECUTE replace(f,old,replacement);
  END IF;
  f:=pg_get_functiondef('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure);
  old:=E'  IF p_policy = ''main_only'' THEN';
  replacement:=$body$  -- chat-wallet-reservation-v1: other consumers cannot spend this round's hold.
  SELECT v_wallet.main_credits-COALESCE(sum(u.reserved_main_credits),0),
    v_wallet.bonus_credits-COALESCE(sum(u.reserved_bonus_credits),0)
    INTO v_wallet.main_credits,v_wallet.bonus_credits
    FROM billing.usage_charges u WHERE u.user_id=p_user_id
      AND (u.reserved_main_credits>0 OR u.reserved_bonus_credits>0)
      AND NOT (p_entry_type='chat_debit' AND u.id::text=v_debit_key);
  UPDATE billing.usage_charges SET reserved_main_credits=0,reserved_bonus_credits=0
    WHERE user_id=p_user_id AND id::text=v_debit_key AND p_entry_type='chat_debit'
      AND (reserved_main_credits>0 OR reserved_bonus_credits>0);
$body$||old;
  IF strpos(f,'chat-wallet-reservation-v1')=0 THEN
    IF (length(f)-length(replace(f,old,'')))/length(old)<>1
      OR strpos(f,'FOR UPDATE')=0 THEN RAISE EXCEPTION 'Unknown wallet debit shape'; END IF;
    EXECUTE replace(f,old,replacement);
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)',
    'billing.reconcile_llm_usage(uuid,numeric,numeric,jsonb)'] LOOP
    f:=replace(pg_get_functiondef(signature::regprocedure),E'\r\n',E'\n');
    IF strpos(f,'chat-balance-terminal-v1')=0 THEN
      IF strpos(f,'billing.usage_charges')=0 OR strpos(f,E'\nBEGIN\n')=0
         OR (strpos(f,E'\nEND\n$function$')=0 AND strpos(f,E'\nEND;\n$function$')=0) THEN RAISE EXCEPTION 'Unknown chat billing function shape'; END IF;
      IF signature='billing.reconcile_llm_usage(uuid,numeric,numeric,jsonb)' THEN
        old:='  v_markup := (v_charge.quote -> ''charge'' ->> ''model_markup'')::NUMERIC;';
        IF (length(f)-length(replace(f,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Unknown legacy reconcile shape'; END IF;
        replacement:=$legacy$  IF v_charge.status='failed' AND v_charge.settled_at IS NOT NULL THEN
    RETURN jsonb_build_object('reconcile_status','failed','wallet',to_jsonb(v_wallet),
      'charge',billing.chat_charge_json(v_charge));
  END IF;
$legacy$||old;
        f:=replace(f,old,replacement);
        old:='  IF v_delta > 0 THEN';
        IF (length(f)-length(replace(f,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'Unknown legacy debit shape'; END IF;
        -- No new partial collection. Previously booked money/ledger is preserved,
        -- but an insufficient additional charge closes permanently with no new debit.
        replacement:=$legacy$  IF v_delta>0 AND v_wallet.main_credits+v_wallet.bonus_credits<v_delta THEN
    RAISE EXCEPTION 'TOTAL_CREDITS_INSUFFICIENT' USING ERRCODE='P0001';
  END IF;
$legacy$||old;
        f:=replace(f,old,replacement);
      END IF;
      -- Keep this row lock OUTSIDE the exception subtransaction: a recharge or
      -- competing replay cannot slip between rejection and the permanent failure.
      f:=replace(f,E'\nBEGIN\n',E'\nBEGIN\n  -- chat-balance-terminal-v1\n  PERFORM 1 FROM billing.usage_charges WHERE id=p_charge_key FOR UPDATE;\n  BEGIN\n');
      replacement:=$body$
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT IN ('MAIN_CREDITS_INSUFFICIENT','TOTAL_CREDITS_INSUFFICIENT') THEN RAISE; END IF;
    PERFORM billing.fail_chat_charge_for_balance(p_charge_key,SQLERRM);
    RETURN jsonb_build_object('charge_status','insufficient_balance','error_code',SQLERRM);
  END;
END
$function$$body$;
      f:=replace(f,E'\nEND\n$function$',replacement);
      f:=replace(f,E'\nEND;\n$function$',replacement);
      EXECUTE f;
    END IF;
  END LOOP;
END $patch$;

REVOKE ALL ON FUNCTION billing.reserve_chat_charge(uuid),billing.fail_chat_charge_for_balance(uuid,text),
  billing.guard_chat_reservation(),billing.release_failed_chat_reservation(),billing.protect_chat_reserved_balance()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION billing.reserve_chat_charge(uuid),billing.fail_chat_charge_for_balance(uuid,text) TO service_role;
COMMIT;
