-- domain: billing
-- Terminal detail/dedup is authoritative; metadata repair cannot create a new debit.
-- Reuses permanent dedup keys and existing indexes. No backfill, new table, index or job.
-- TEST first, then this migration before the backend archived-result consumer.
-- Recovery: keep this additive result contract; roll back the backend only if necessary.
-- Old backends reject archived results (as they already rejected the former null result),
-- but neither old nor new consumers can debit an archived key again. Forward-fix only;
-- never delete dedup facts or roll back wallet data.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$
DECLARE d text; old text; new text; archived_lookup text;
BEGIN
  SELECT pg_get_functiondef('billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure) INTO d;
  IF position('already_archived' IN d)=0 THEN
    old := '  v_existing billing.llm_usage_charges;';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected charge declaration'; END IF;
    d := replace(d,old,old||E'\n  v_archived billing.llm_usage_charge_dedup;');

    archived_lookup := $patch$
  SELECT * INTO v_archived
  FROM billing.llm_usage_charge_dedup
  WHERE charge_key = p_charge_key
     OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
  ORDER BY (charge_key = p_charge_key) DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_archived.user_id IS DISTINCT FROM p_user_id
       OR v_archived.status NOT IN ('failed','free','charged','partial','reconciled','historical')
       OR v_archived.charged_amount IS NULL OR v_archived.charged_amount < 0 THEN
      RAISE EXCEPTION 'Invalid archived LLM charge result' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object(
      'charge_status','already_archived',
      'archived_charge',jsonb_build_object(
        'charge_key',v_archived.charge_key,'generation_id',v_archived.generation_id,
        'user_id',v_archived.user_id,'status',v_archived.status,
        'charged_amount',v_archived.charged_amount));
  END IF;
$patch$;

    old := '  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);';
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected delivery gate'; END IF;
    new := $patch$  -- Read-only terminal fast path: no request-row lock or history scan for settled keys.
  -- Pending calls retain the original gate -> charge lock order below.
  SELECT * INTO v_existing
  FROM billing.llm_usage_charges
  WHERE charge_key = p_charge_key
     OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
  ORDER BY (charge_key = p_charge_key) DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'LLM charge owner mismatch' USING ERRCODE='22023';
    END IF;
    IF v_existing.status <> 'pending' THEN
      SELECT to_jsonb(w.*) INTO v_wallet_json FROM billing.user_wallets w
      WHERE w.user_id=v_existing.user_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Settled LLM charge wallet missing'; END IF;
      RETURN jsonb_build_object('charge_status','already_charged',
        'wallet',v_wallet_json,'charge',to_jsonb(v_existing));
    END IF;
  ELSE
$patch$ || archived_lookup || E'  END IF;\n\n' || old;
    d := replace(d,old,new);

    old := $patch$      WHEN unique_violation THEN
        -- 子事务回滚本次 debit。赢家的行已经提交，按它返回。
        SELECT * INTO v_existing
        FROM billing.llm_usage_charges
        WHERE charge_key = p_charge_key
           OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
        ORDER BY (charge_key = p_charge_key) DESC
        LIMIT 1;
        SELECT to_jsonb(w.*) INTO v_wallet_json
        FROM billing.user_wallets w
        WHERE w.user_id = v_existing.user_id;
        RETURN jsonb_build_object(
          'charge_status', 'already_charged',
          'wallet', v_wallet_json,
          'charge', to_jsonb(v_existing)
        );$patch$;
    IF position(old IN d)=0 THEN RAISE EXCEPTION 'Unexpected unique-conflict recovery'; END IF;
    new := $patch$      WHEN unique_violation THEN
        -- This subtransaction has rolled back its debit. Return only durable proof
        -- of the winner; a pruned winner lives in dedup, never in a fabricated row.
        SELECT * INTO v_existing
        FROM billing.llm_usage_charges
        WHERE charge_key = p_charge_key
           OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
        ORDER BY (charge_key = p_charge_key) DESC
        LIMIT 1;
        IF FOUND THEN
          IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
            RAISE EXCEPTION 'LLM charge owner mismatch' USING ERRCODE='22023';
          END IF;
          SELECT to_jsonb(w.*) INTO v_wallet_json FROM billing.user_wallets w
          WHERE w.user_id=v_existing.user_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'Existing LLM charge wallet missing'; END IF;
          RETURN jsonb_build_object(
            'charge_status',CASE WHEN v_existing.status='pending' THEN 'already_pending' ELSE 'already_charged' END,
            'wallet',v_wallet_json,'charge',to_jsonb(v_existing));
        END IF;
$patch$ || archived_lookup || $patch$
        -- An unrelated uniqueness failure is an error, not a successful empty result.
        RAISE;$patch$;
    d := replace(d,old,new);
    EXECUTE d;
  END IF;
END;
$$;

-- CREATE OR REPLACE retains the existing ACL; public callers must remain excluded.
DO $$
BEGIN
  IF has_function_privilege('anon','billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected public charge privilege';
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
