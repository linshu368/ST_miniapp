-- Production originals (11-21) of the text charge chain, verified by md5(prosrc). Test fixture only:
-- used by scripts/test-db-reorg-p6b1c-charge-chain.sh to run the old path next to the new one. Never applied anywhere.

CREATE OR REPLACE FUNCTION billing.charge_llm_usage(p_charge_key uuid, p_generation_id text, p_user_id uuid, p_model_id text, p_model_openrouter_id text, p_model_display_name text, p_catalog_version integer, p_pricing_config_version integer, p_usage_cost_usd numeric, p_exchange_rate numeric, p_model_markup numeric, p_calculated_amount numeric, p_fallback_used boolean, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_existing billing.llm_usage_charges;
  v_archived billing.llm_usage_charge_dedup;
  v_charge billing.llm_usage_charges;
  v_metadata JSONB := COALESCE(p_metadata, '{}'::JSONB);
  v_stored JSONB;
  v_quote_metadata JSONB;
  v_fixed BOOLEAN;
  v_chat_status TEXT;
  v_finish_reason TEXT;
  v_waiting_finish BOOLEAN;
  v_non_billable_fixed BOOLEAN;
  v_pending BOOLEAN;
  v_quoted NUMERIC;
  v_amount NUMERIC(14,1);
  v_policy TEXT;
  v_category TEXT;
  v_debit_key TEXT;
  v_debit JSONB;
  v_ledger_id UUID;
  v_main NUMERIC(14,1) := 0;
  v_bonus NUMERIC(14,1) := 0;
  v_wallet_json JSONB;
  v_billing_gate TEXT;
  v_difference_reason TEXT;
  v_has_existing BOOLEAN := false;
  v_delivery_gate TEXT;
  v_stop_snapshot JSONB;
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL
     OR COALESCE(btrim(p_model_openrouter_id), '') = ''
     OR COALESCE(btrim(p_model_display_name), '') = ''
     OR p_exchange_rate <= 0 OR p_model_markup < 0 THEN
    RAISE EXCEPTION 'invalid LLM usage charge input' USING ERRCODE = '22023';
  END IF;

  -- Serialize display receipt and debit eligibility on the same request row.
  -- No client receipt is never interpreted as a successful display.
  -- Read-only terminal fast path: no request-row lock or history scan for settled keys.
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
  END IF;

  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);
  IF v_delivery_gate='user_stopped' THEN
    SELECT llm_billing_snapshot INTO v_stop_snapshot FROM experience.chat_history
      WHERE llm_charge_id=p_charge_key;
    -- The persisted accepted quote wins; no repricing from the current catalogue.
    v_metadata := v_metadata || v_stop_snapshot || jsonb_build_object(
      'billing_mode','fixed_tier','billing_trigger','user_stop',
      'chat_status','stream_interrupted','finish_reason','user_cancelled');
  END IF;
  IF v_delivery_gate <> 'legacy' THEN
    v_metadata := v_metadata || jsonb_build_object('delivery_billing_gate', v_delivery_gate);
    IF COALESCE(v_metadata->>'chat_status', 'success') = 'success'
       AND (v_metadata->>'finish_reason' IS NULL OR v_metadata->>'finish_reason' = 'stop') THEN
      IF v_delivery_gate = 'pending' THEN
        v_metadata := v_metadata || jsonb_build_object(
          'billing_mode', 'fixed_tier', 'finish_reason', NULL);
      ELSIF v_delivery_gate = 'waived' THEN
        v_metadata := v_metadata || jsonb_build_object(
          'billing_mode', 'fixed_tier', 'chat_status', 'stream_interrupted', 'finish_reason', 'timeout');
      END IF;
    END IF;
  END IF;

  v_fixed := COALESCE(v_metadata ->> 'billing_mode', '') = 'fixed_tier';
  v_chat_status := COALESCE(v_metadata ->> 'chat_status', 'success');
  v_finish_reason := v_metadata ->> 'finish_reason';
  v_waiting_finish := v_fixed AND v_chat_status = 'success' AND v_finish_reason IS NULL;
  v_non_billable_fixed := v_fixed
    AND NOT v_waiting_finish
    AND v_delivery_gate <> 'user_stopped'
    AND (v_chat_status <> 'success' OR v_finish_reason <> 'stop');
  v_pending := CASE
    WHEN v_fixed THEN v_waiting_finish
    ELSE p_model_markup > 0
      AND (COALESCE(p_fallback_used, false) OR p_usage_cost_usd IS NULL)
  END;
  v_debit_key := p_charge_key::TEXT;

  SELECT * INTO v_existing
  FROM billing.llm_usage_charges
  WHERE charge_key = p_charge_key
     OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
  ORDER BY (charge_key = p_charge_key) DESC
  LIMIT 1
  FOR UPDATE;
  v_has_existing := FOUND;

  IF v_has_existing AND v_existing.status <> 'pending' THEN
    SELECT to_jsonb(w.*) INTO v_wallet_json
    FROM billing.user_wallets w
    WHERE w.user_id = v_existing.user_id
    FOR UPDATE;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_existing)
    );
  END IF;

  v_quote_metadata := CASE
    WHEN NOT v_has_existing THEN '{}'::JSONB
    ELSE COALESCE(v_existing.metadata, '{}'::JSONB)
  END;
  -- 已落库的快照优先于本次参数，避免目录改价或 VIP 到期后重放改写本轮实付。
  v_quoted := COALESCE(
    NULLIF(v_quote_metadata ->> 'payable_credits', '')::NUMERIC,
    NULLIF(v_quote_metadata ->> 'fixed_deduction', '')::NUMERIC,
    NULLIF(v_metadata ->> 'payable_credits', '')::NUMERIC,
    NULLIF(v_metadata ->> 'fixed_deduction', '')::NUMERIC,
    p_calculated_amount,
    0
  );
  IF v_quoted < 0 OR (v_quoted > 0 AND v_quoted <> trunc(v_quoted)) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  v_amount := CASE
    WHEN v_fixed AND (v_waiting_finish OR v_non_billable_fixed) THEN 0
    WHEN v_fixed THEN v_quoted
    WHEN p_model_markup = 0 OR v_pending THEN 0
    ELSE v_quoted
  END;

  v_category := COALESCE(
    NULLIF(v_quote_metadata ->> 'fixed_deduction_category', ''),
    NULLIF(v_metadata ->> 'fixed_deduction_category', ''),
    NULLIF(v_quote_metadata ->> 'model_tier', ''),
    NULLIF(v_metadata ->> 'model_tier', '')
  );
  v_policy := NULLIF(btrim(COALESCE(
    NULLIF(v_quote_metadata ->> 'wallet_policy', ''),
    NULLIF(v_metadata ->> 'wallet_policy', '')
  )), '');
  IF v_policy IS NULL AND v_amount > 0 THEN
    IF v_category IN ('light', 'free_quota', 'free_quota_exhausted', 'text_light') THEN
      v_policy := 'main_then_bonus';
    ELSIF v_category IN ('standard', 'premium', 'standard_fallback', 'text_standard', 'text_premium') THEN
      v_policy := 'main_only';
    END IF;
  END IF;
  IF v_amount > 0 AND v_policy IS NULL THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_POLICY' USING ERRCODE = 'P0001';
  END IF;
  IF v_policy IS NOT NULL AND v_policy NOT IN ('main_only', 'main_then_bonus') THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_POLICY' USING ERRCODE = 'P0001';
  END IF;

  v_billing_gate := CASE
    WHEN v_fixed AND v_waiting_finish THEN 'pending_finish_reason'
    WHEN v_fixed AND v_non_billable_fixed THEN 'non_billable'
    WHEN v_fixed AND v_amount = 0 THEN 'free'
    WHEN v_fixed THEN 'billable'
    WHEN p_model_markup = 0 THEN 'free'
    WHEN v_pending THEN 'deferred'
    ELSE 'actual_usage'
  END;
  v_difference_reason := CASE
    WHEN v_delivery_gate = 'user_stopped' THEN 'user_stop'
    WHEN v_delivery_gate = 'pending' THEN 'awaiting_visible_token'
    WHEN v_delivery_gate = 'waived' THEN 'no_visible_token'
    WHEN v_fixed AND v_waiting_finish THEN 'awaiting_finish_reason'
    WHEN v_fixed AND v_chat_status = 'stream_interrupted' THEN 'stream_interrupted'
    WHEN v_fixed AND v_chat_status = 'upstream_error' THEN 'upstream_error'
    WHEN v_fixed AND v_finish_reason = 'content_filter' THEN 'content_filter'
    WHEN v_fixed AND v_finish_reason = 'length' THEN 'length'
    WHEN v_fixed AND v_finish_reason IN ('tool_calls', 'function_call') THEN 'tool_call'
    WHEN v_fixed AND v_non_billable_fixed THEN 'non_stop_finish_reason'
    WHEN NOT v_fixed AND p_model_markup = 0 THEN 'free_model'
    WHEN NOT v_fixed AND v_pending THEN 'awaiting_openrouter_usage'
    ELSE NULL
  END;

  IF v_has_existing AND v_existing.status = 'pending' AND v_waiting_finish THEN
    SELECT to_jsonb(w.*) INTO v_wallet_json
    FROM billing.user_wallets w
    WHERE w.user_id = v_existing.user_id
    FOR UPDATE;
    RETURN jsonb_build_object(
      'charge_status', 'already_pending',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_existing)
    );
  END IF;

  v_stored := CASE
    WHEN NOT v_has_existing THEN v_metadata
    ELSE COALESCE(v_existing.metadata, '{}'::JSONB) || (
      v_metadata
        - 'payable_credits' - 'fixed_deduction' - 'wallet_policy'
        - 'original_credits' - 'discount_rate' - 'discounted_exact'
        - 'vip_active' - 'vip_valid_until' - 'model_tier'
        - 'requires_vip' - 'fixed_deduction_category'
        - 'creator_reward'
    )
  END;
  v_stored := v_stored || jsonb_strip_nulls(jsonb_build_object(
    'payable_credits', v_quoted,
    'wallet_policy', v_policy,
    'billing_mode', CASE
      WHEN v_fixed THEN 'fixed_tier'
      WHEN p_model_markup = 0 THEN 'free'
      WHEN v_pending THEN 'deferred'
      ELSE 'actual_usage'
    END,
    'billing_gate', v_billing_gate,
    'finish_reason', v_finish_reason,
    'difference_reason', v_difference_reason
  ));

  IF v_amount > 0 THEN
    PERFORM billing.lock_character_creator_wallets(p_user_id, v_stored->'creator_reward');
  END IF;

  IF v_has_existing THEN
    IF v_amount > 0 THEN
      -- 不足时异常冒泡，整笔回滚。pending 保持原状，由 sync 以后重试，不写 partial。
      v_debit_key := v_existing.charge_key::TEXT;
      v_debit := billing.apply_wallet_debit(
        v_existing.user_id,
        v_debit_key,
        v_policy,
        v_amount,
        'chat_debit',
        'llm_usage',
        v_debit_key,
        v_stored || jsonb_build_object(
          'generation_id', COALESCE(p_generation_id, v_existing.generation_id),
          'model', p_model_openrouter_id,
          'calculated_amount', v_amount
        )
      );
      v_ledger_id := (v_debit ->> 'ledger_id')::UUID;
      v_main := (v_debit -> 'split' ->> 'main_credits')::NUMERIC;
      v_bonus := (v_debit -> 'split' ->> 'bonus_credits')::NUMERIC;
      v_wallet_json := v_debit -> 'wallet';
      v_stored := v_stored || jsonb_build_object(
        'main_delta', -v_main,
        'bonus_delta', -v_bonus,
        'debit_key', v_debit_key
      );
    ELSE
      INSERT INTO billing.user_wallets (user_id)
      VALUES (v_existing.user_id)
      ON CONFLICT (user_id) DO NOTHING;
      SELECT to_jsonb(w.*) INTO v_wallet_json
      FROM billing.user_wallets w
      WHERE w.user_id = v_existing.user_id;
    END IF;

    UPDATE billing.llm_usage_charges
    SET generation_id = COALESCE(p_generation_id, generation_id),
        model_openrouter_id = p_model_openrouter_id,
        model_display_name = p_model_display_name,
        usage_cost_usd = p_usage_cost_usd,
        calculated_amount = v_amount,
        charged_amount = v_amount,
        fallback_used = false,
        status = CASE
          WHEN v_non_billable_fixed THEN 'failed'
          WHEN v_amount = 0 THEN 'free'
          ELSE 'charged'
        END,
        debit_ledger_id = COALESCE(v_ledger_id, debit_ledger_id),
        metadata = v_stored,
        reconciled_at = now()
    WHERE charge_key = v_existing.charge_key
    RETURNING * INTO v_charge;
  ELSE
    BEGIN
      IF v_amount > 0 THEN
        v_debit := billing.apply_wallet_debit(
          p_user_id,
          v_debit_key,
          v_policy,
          v_amount,
          'chat_debit',
          'llm_usage',
          v_debit_key,
          v_stored || jsonb_build_object(
            'generation_id', p_generation_id,
            'model', p_model_openrouter_id,
            'calculated_amount', v_amount
          )
        );
        v_ledger_id := (v_debit ->> 'ledger_id')::UUID;
        v_main := (v_debit -> 'split' ->> 'main_credits')::NUMERIC;
        v_bonus := (v_debit -> 'split' ->> 'bonus_credits')::NUMERIC;
        v_wallet_json := v_debit -> 'wallet';
        v_stored := v_stored || jsonb_build_object(
          'main_delta', -v_main,
          'bonus_delta', -v_bonus,
          'debit_key', v_debit_key
        );
      ELSE
        INSERT INTO billing.user_wallets (user_id)
        VALUES (p_user_id)
        ON CONFLICT (user_id) DO NOTHING;
        SELECT to_jsonb(w.*) INTO v_wallet_json
        FROM billing.user_wallets w
        WHERE w.user_id = p_user_id;
      END IF;

      INSERT INTO billing.llm_usage_charges(
        charge_key, generation_id, user_id, model_id, model_openrouter_id,
        model_display_name, catalog_version, pricing_config_version,
        usage_cost_usd, exchange_rate, model_markup, initial_amount,
        calculated_amount, charged_amount, fallback_used, status,
        debit_ledger_id, metadata
      ) VALUES (
        p_charge_key, p_generation_id, p_user_id, p_model_id, p_model_openrouter_id,
        p_model_display_name, COALESCE(p_catalog_version, 0),
        COALESCE(p_pricing_config_version, 0), p_usage_cost_usd, p_exchange_rate,
        p_model_markup, v_amount, v_amount, v_amount, false,
        CASE
          WHEN v_pending THEN 'pending'
          WHEN v_fixed AND v_non_billable_fixed THEN 'failed'
          WHEN v_amount = 0 THEN 'free'
          ELSE 'charged'
        END,
        v_ledger_id, v_stored
      ) RETURNING * INTO v_charge;
    EXCEPTION
      WHEN unique_violation THEN
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

        -- An unrelated uniqueness failure is an error, not a successful empty result.
        RAISE;
    END;
  END IF;

  PERFORM billing.grant_character_creator_reward(v_charge);

  RETURN jsonb_build_object(
    'charge_status', v_charge.status,
    'wallet', v_wallet_json,
    'charge', to_jsonb(v_charge)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION billing.reconcile_llm_usage(p_charge_key uuid, p_usage_cost_usd numeric, p_calculated_amount numeric, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_charge billing.llm_usage_charges;
  v_wallet billing.user_wallets;
  v_target NUMERIC(14,1);
  v_delta NUMERIC(14,1);
  v_applied NUMERIC(14,1) := 0;
  v_bonus NUMERIC(14,1) := 0;
  v_main NUMERIC(14,1) := 0;
  v_net_bonus_debit NUMERIC(14,1);
  v_net_main_debit NUMERIC(14,1);
BEGIN
  SELECT * INTO v_charge
  FROM billing.llm_usage_charges
  WHERE charge_key = p_charge_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LLM usage charge not found: %', p_charge_key
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = v_charge.user_id
  FOR UPDATE;

  v_target := CASE
    WHEN v_charge.model_markup = 0 THEN 0
    ELSE round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
  END;
  v_delta := v_target - v_charge.charged_amount;

  IF v_delta > 0 THEN
    v_applied := LEAST(v_delta, v_wallet.main_credits + v_wallet.bonus_credits);
    v_bonus := LEAST(v_wallet.bonus_credits, v_applied);
    v_main := v_applied - v_bonus;
    IF v_applied > 0 THEN
      UPDATE billing.user_wallets
      SET bonus_credits = bonus_credits - v_bonus,
          main_credits = main_credits - v_main,
          updated_at = now()
      WHERE user_id = v_charge.user_id
      RETURNING * INTO v_wallet;

      INSERT INTO billing.wallet_ledger(
        user_id, entry_type, amount, main_delta, bonus_delta,
        balance_main, balance_bonus, reference_type, reference_id, metadata
      ) VALUES (
        v_charge.user_id, 'adjustment', -v_applied, -v_main, -v_bonus,
        v_wallet.main_credits, v_wallet.bonus_credits,
        'llm_usage', v_charge.charge_key::TEXT,
        COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
          'reason', 'late_usage_reconcile', 'target_amount', v_target
        )
      );
    END IF;
  ELSIF v_delta < 0 THEN
    v_applied := -v_delta;
    SELECT
      GREATEST(-COALESCE(sum(main_delta), 0), 0),
      GREATEST(-COALESCE(sum(bonus_delta), 0), 0)
    INTO v_net_main_debit, v_net_bonus_debit
    FROM billing.wallet_ledger
    WHERE reference_type = 'llm_usage'
      AND reference_id = v_charge.charge_key::TEXT;

    v_bonus := LEAST(v_applied, v_net_bonus_debit);
    v_main := v_applied - v_bonus;
    UPDATE billing.user_wallets
    SET bonus_credits = bonus_credits + v_bonus,
        main_credits = main_credits + v_main,
        updated_at = now()
    WHERE user_id = v_charge.user_id
    RETURNING * INTO v_wallet;

    INSERT INTO billing.wallet_ledger(
      user_id, entry_type, amount, main_delta, bonus_delta,
      balance_main, balance_bonus, reference_type, reference_id, metadata
    ) VALUES (
      v_charge.user_id, 'refund', v_applied, v_main, v_bonus,
      v_wallet.main_credits, v_wallet.bonus_credits,
      'llm_usage', v_charge.charge_key::TEXT,
      COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
        'reason', 'late_usage_reconcile', 'target_amount', v_target
      )
    );
    v_applied := -v_applied;
  END IF;

  UPDATE billing.llm_usage_charges
  SET usage_cost_usd = p_usage_cost_usd,
      calculated_amount = v_target,
      charged_amount = charged_amount + v_applied,
      fallback_used = false,
      status = CASE
        WHEN model_markup = 0 THEN 'free'
        WHEN charged_amount + v_applied = v_target THEN 'reconciled'
        ELSE 'partial'
      END,
      metadata = metadata || COALESCE(p_metadata, '{}'::JSONB),
      reconciled_at = now(),
      updated_at = now()
  WHERE id = v_charge.id
  RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'reconcile_status', v_charge.status,
    'wallet', to_jsonb(v_wallet),
    'charge', to_jsonb(v_charge)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION billing.refund_llm_usage_charge(p_charge_key uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_charge billing.llm_usage_charges;
  v_debit_key TEXT;
  v_ledger_key TEXT;
  v_refund JSONB;
  v_wallet_json JSONB;
  v_status TEXT;
BEGIN
  IF p_charge_key IS NULL THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_charge
  FROM billing.llm_usage_charges
  WHERE charge_key = p_charge_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 'not_found');
  END IF;

  SELECT to_jsonb(w.*) INTO v_wallet_json
  FROM billing.user_wallets w
  WHERE w.user_id = v_charge.user_id;

  IF v_charge.charged_amount <= 0 OR v_charge.debit_ledger_id IS NULL
     OR v_charge.status IN ('pending', 'free', 'failed') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'not_debited',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_charge)
    );
  END IF;

  v_debit_key := p_charge_key::TEXT;
  SELECT ledger.debit_key INTO v_ledger_key
  FROM billing.wallet_ledger ledger
  WHERE ledger.id = v_charge.debit_ledger_id;

  -- 旧扣款没有 debit_key，不能猜拆分。保持余额不动。
  IF v_ledger_key IS NULL OR v_ledger_key IS DISTINCT FROM v_debit_key THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'not_refundable',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_charge)
    );
  END IF;

  PERFORM billing.lock_character_creator_wallets(v_charge.user_id, v_charge.metadata->'creator_reward');
  v_refund := billing.refund_wallet_debit(
    'llm-refund:' || v_debit_key,
    v_debit_key,
    'llm_usage'
  );
  v_status := v_refund ->> 'status';
  PERFORM billing.reverse_character_creator_reward(p_charge_key);
  v_wallet_json := v_refund -> 'wallet';

  UPDATE billing.llm_usage_charges
  SET metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_strip_nulls(jsonb_build_object(
        'compensation_status', 'refunded',
        'business_status', 'refunded',
        'refund_key', v_refund ->> 'refund_key',
        'refund_of', v_debit_key,
        'compensation_reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )),
      reconciled_at = now()
  WHERE charge_key = p_charge_key
  RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_status,
    'wallet', v_wallet_json,
    'charge', to_jsonb(v_charge),
    'split', v_refund -> 'split'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION billing.grant_character_creator_reward(p_charge billing.llm_usage_charges)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE v_rule jsonb; v_creator uuid; v_reward numeric(14,1); v_offset numeric(14,1);
  v_credit numeric(14,1); v_debt numeric(14,1); v_ledger uuid;
BEGIN
  v_rule := p_charge.metadata->'creator_reward';
  IF v_rule IS NULL OR p_charge.charged_amount <= 0
    OR p_charge.status IN ('pending','free','failed')
    OR p_charge.metadata->>'business_status' = 'refunded' THEN RETURN; END IF;
  v_creator := (v_rule->>'creator_user_id')::uuid;
  IF v_creator = p_charge.user_id THEN RETURN; END IF;
  -- Called only by the final charge branch; an archived or duplicate charge
  -- returns earlier and cannot recreate grants after detail retention.
  IF EXISTS(SELECT 1 FROM billing.character_creator_rewards WHERE charge_key=p_charge.charge_key) THEN RETURN; END IF;
  v_reward := round(p_charge.charged_amount * (v_rule->>'rate')::numeric, 1);
  IF v_reward <= 0 THEN RETURN; END IF;
  INSERT INTO billing.character_creator_reward_balances(creator_user_id)
    VALUES(v_creator) ON CONFLICT(creator_user_id) DO NOTHING;
  SELECT outstanding_debt INTO v_debt FROM billing.character_creator_reward_balances
    WHERE creator_user_id=v_creator FOR UPDATE;
  v_offset := least(v_debt, v_reward);
  v_credit := v_reward-v_offset;
  UPDATE billing.character_creator_reward_balances
    SET outstanding_debt=outstanding_debt-v_offset, updated_at=now()
    WHERE creator_user_id=v_creator;
  IF v_credit > 0 THEN
    SELECT o_ledger_id INTO v_ledger FROM billing.grant_bonus_credits(
      v_creator, v_credit, 'creator_reward', 'llm_creator_reward', p_charge.charge_key::text,
      jsonb_build_object('charge_key',p_charge.charge_key,'character_id',v_rule->>'character_id',
        'charged_amount',p_charge.charged_amount,'reward_amount',v_reward,
        'debt_offset_amount',v_offset,'policy_version',1));
  END IF;
  INSERT INTO billing.character_creator_rewards(charge_key, character_id, creator_user_id,
    payer_user_id, charged_amount, reward_rate, reward_amount, debt_offset_amount,
    credited_amount, grant_ledger_id)
  VALUES(p_charge.charge_key,(v_rule->>'character_id')::uuid,v_creator,p_charge.user_id,
    p_charge.charged_amount,0.4,v_reward,v_offset,v_credit,v_ledger);
END $function$;

CREATE OR REPLACE FUNCTION billing.prepare_llm_usage_charge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- Only free-model failures are represented as failed spending details.
  -- Paid failures continue to produce no charge row.
  IF NEW.model_markup = 0
     AND COALESCE(NEW.metadata ->> 'chat_status', 'success') <> 'success' THEN
    NEW.status := 'failed';
    NEW.initial_amount := 0;
    NEW.calculated_amount := 0;
    NEW.charged_amount := 0;
    NEW.fallback_used := false;
    NEW.metadata := COALESCE(NEW.metadata, '{}'::JSONB) || jsonb_build_object(
      'billing_mode', 'failed_free',
      'difference_reason', 'generation_failed'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM billing.llm_usage_charge_dedup AS dedup
    WHERE dedup.charge_key = NEW.charge_key
       OR (
         NEW.generation_id IS NOT NULL
         AND dedup.generation_id = NEW.generation_id
       )
  ) THEN
    RAISE EXCEPTION 'LLM usage charge already processed and pruned'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION billing.retain_recent_llm_usage_charges()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO billing.llm_usage_charge_dedup(
    charge_key, generation_id, user_id, charged_amount, status, processed_at
  ) VALUES (
    NEW.charge_key,
    NEW.generation_id,
    NEW.user_id,
    NEW.charged_amount,
    NEW.status,
    NEW.created_at
  )
  ON CONFLICT (charge_key) DO UPDATE
  SET generation_id = COALESCE(
        billing.llm_usage_charge_dedup.generation_id,
        EXCLUDED.generation_id
      ),
      charged_amount = EXCLUDED.charged_amount,
      status = EXCLUDED.status;

  -- Pending rows are temporarily retained even when older than the latest
  -- 100 so they can settle. Their reconciliation update invokes this trigger
  -- again and makes them eligible for pruning.
  DELETE FROM billing.llm_usage_charges AS charge
  WHERE charge.user_id = NEW.user_id
    AND charge.status <> 'pending'
    AND charge.id IN (
      SELECT ranked.id
      FROM billing.llm_usage_charges AS ranked
      WHERE ranked.user_id = NEW.user_id
      ORDER BY ranked.created_at DESC, ranked.id DESC
      OFFSET 100
    );

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_prepare_llm_usage_charge BEFORE INSERT ON billing.llm_usage_charges FOR EACH ROW EXECUTE FUNCTION billing.prepare_llm_usage_charge();
CREATE TRIGGER trg_retain_recent_llm_usage_charges AFTER INSERT OR UPDATE OF status, charged_amount ON billing.llm_usage_charges FOR EACH ROW EXECUTE FUNCTION billing.retain_recent_llm_usage_charges();
