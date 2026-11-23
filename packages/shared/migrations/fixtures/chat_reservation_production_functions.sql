-- Structural production function definitions captured 2026-11-23. No business rows.
CREATE OR REPLACE FUNCTION billing.chat_archived_charge_result(p_charge billing.usage_charges, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  -- A settled charge whose detail was pruned before db reorg 6b-1 (formerly llm_usage_charge_dedup):
  -- only the durable result survives, never a fabricated detail row.
  IF p_charge.user_id IS DISTINCT FROM p_user_id
     OR p_charge.status NOT IN ('failed','free','charged','partial','reconciled','historical')
     OR p_charge.charged_credits IS NULL OR p_charge.charged_credits < 0 THEN
    RAISE EXCEPTION 'Invalid archived LLM charge result' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object(
    'charge_status','already_archived',
    'archived_charge',jsonb_build_object(
      'charge_key',p_charge.id,'generation_id',p_charge.generation_id,
      'user_id',p_charge.user_id,'status',p_charge.status,
      'charged_amount',p_charge.charged_credits));
END
$function$;
CREATE OR REPLACE FUNCTION billing.chat_charge_json(p_charge billing.usage_charges)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  -- 文本扣费返回给后端的形状，与 6b-1c 之前旧扣费表的一行相同（不含旧表自增 id；上游成本归 ops.llm_calls，恒为 null）。
  SELECT jsonb_build_object(
    'charge_key', p_charge.id, 'generation_id', p_charge.generation_id, 'user_id', p_charge.user_id,
    'model_id', c -> 'model_id', 'model_openrouter_id', c -> 'model_openrouter_id', 'model_display_name', c -> 'model_display_name',
    'catalog_version', c -> 'catalog_version', 'pricing_config_version', c -> 'pricing_config_version', 'usage_cost_usd', NULL,
    'exchange_rate', c -> 'exchange_rate', 'model_markup', c -> 'model_markup', 'initial_amount', c -> 'initial_amount',
    'calculated_amount', c -> 'calculated_amount', 'charged_amount', p_charge.charged_credits, 'fallback_used', c -> 'fallback_used',
    'status', p_charge.status, 'debit_ledger_id', p_charge.debit_ledger_id, 'metadata', c -> 'metadata',
    'created_at', c -> 'charged_at', 'updated_at', p_charge.updated_at, 'reconciled_at', c -> 'reconciled_at')
  FROM (SELECT p_charge.quote -> 'charge' AS c) d
$function$;
CREATE OR REPLACE FUNCTION billing.reconcile_llm_usage(p_charge_key uuid, p_usage_cost_usd numeric, p_calculated_amount numeric, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  -- db reorg 6b-1c: reads and writes billing.usage_charges; only rows with a charge detail can be reconciled.
  v_charge billing.usage_charges;
  v_wallet billing.user_wallets;
  v_markup NUMERIC;
  v_target NUMERIC(14,1);
  v_delta NUMERIC(14,1);
  v_applied NUMERIC(14,1) := 0;
  v_bonus NUMERIC(14,1) := 0;
  v_main NUMERIC(14,1) := 0;
  v_net_bonus_debit NUMERIC(14,1);
  v_net_main_debit NUMERIC(14,1);
  v_metadata JSONB;
BEGIN
  SELECT * INTO v_charge
  FROM billing.usage_charges
  WHERE id = p_charge_key AND kind = 'chat_text' AND quote ? 'charge'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LLM usage charge not found: %', p_charge_key
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = v_charge.user_id
  FOR UPDATE;

  v_markup := (v_charge.quote -> 'charge' ->> 'model_markup')::NUMERIC;
  v_target := CASE
    WHEN v_markup = 0 THEN 0
    ELSE round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
  END;
  v_delta := v_target - v_charge.charged_credits;

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
        'llm_usage', v_charge.id::TEXT,
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
      AND reference_id = v_charge.id::TEXT;

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
      'llm_usage', v_charge.id::TEXT,
      COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
        'reason', 'late_usage_reconcile', 'target_amount', v_target
      )
    );
    v_applied := -v_applied;
  END IF;

  v_metadata := COALESCE(v_charge.quote -> 'charge' -> 'metadata', '{}'::JSONB) || COALESCE(p_metadata, '{}'::JSONB);
  UPDATE billing.usage_charges
  SET charged_credits = charged_credits + v_applied,
      status = CASE
        WHEN v_markup = 0 THEN 'free'
        WHEN charged_credits + v_applied = v_target THEN 'reconciled'
        ELSE 'partial'
      END,
      billing_mode = COALESCE(v_metadata ->> 'billing_mode', billing_mode),
      quote = quote || jsonb_build_object('charge', (quote -> 'charge') || jsonb_build_object(
        'calculated_amount', v_target,
        'fallback_used', false,
        'metadata', v_metadata,
        'reconciled_at', now())),
      updated_at = now()
  WHERE id = v_charge.id
  RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'reconcile_status', v_charge.status,
    'wallet', to_jsonb(v_wallet),
    'charge', billing.chat_charge_json(v_charge)
  );
END;
$function$;
CREATE OR REPLACE FUNCTION billing.charge_llm_usage(p_charge_key uuid, p_generation_id text, p_user_id uuid, p_model_id text, p_model_openrouter_id text, p_model_display_name text, p_catalog_version integer, p_pricing_config_version integer, p_usage_cost_usd numeric, p_exchange_rate numeric, p_model_markup numeric, p_calculated_amount numeric, p_fallback_used boolean, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  -- db reorg 6b-1c: billing.usage_charges is the only charge record. A row is
  --   * charged detail  (quote ? 'charge')            -> what llm_usage_charges used to hold;
  --   * archived result (no detail, terminal status)  -> what llm_usage_charge_dedup used to hold after pruning;
  --   * open quote      (no detail, status 'quoted')  -> no charge yet: this call charges and fills that row.
  v_existing billing.usage_charges;
  v_charge billing.usage_charges;
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
  v_open_quote BOOLEAN := false;
  v_delivery_gate TEXT;
  v_stop_snapshot JSONB;
  v_status TEXT;
  v_recorded NUMERIC(14,1);
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL
     OR COALESCE(btrim(p_model_openrouter_id), '') = ''
     OR COALESCE(btrim(p_model_display_name), '') = ''
     OR p_exchange_rate <= 0 OR p_model_markup < 0 THEN
    RAISE EXCEPTION 'invalid LLM usage charge input' USING ERRCODE = '22023';
  END IF;

  -- Read-only terminal fast path: no request-row lock for settled keys.
  -- Charged rows outrank archived results, which outrank open quotes; the own key wins ties.
  SELECT * INTO v_existing
  FROM billing.usage_charges
  WHERE kind = 'chat_text'
    AND (id = p_charge_key OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id))
  ORDER BY (quote ? 'charge') DESC, (status <> 'quoted') DESC, (id = p_charge_key) DESC
  LIMIT 1;
  IF FOUND AND v_existing.quote ? 'charge' THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'LLM charge owner mismatch' USING ERRCODE='22023';
    END IF;
    IF v_existing.status <> 'pending' THEN
      SELECT to_jsonb(w.*) INTO v_wallet_json FROM billing.user_wallets w
      WHERE w.user_id=v_existing.user_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Settled LLM charge wallet missing'; END IF;
      RETURN jsonb_build_object('charge_status','already_charged',
        'wallet',v_wallet_json,'charge',billing.chat_charge_json(v_existing));
    END IF;
  ELSIF FOUND AND v_existing.status <> 'quoted' THEN
    RETURN billing.chat_archived_charge_result(v_existing, p_user_id);
  END IF;

  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);
  IF v_delivery_gate='user_stopped' THEN
    SELECT quote -> 'snapshot' INTO v_stop_snapshot FROM billing.usage_charges
      WHERE id=p_charge_key;
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
  FROM billing.usage_charges
  WHERE kind = 'chat_text'
    AND (id = p_charge_key OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id))
  ORDER BY (quote ? 'charge') DESC, (status <> 'quoted') DESC, (id = p_charge_key) DESC
  LIMIT 1
  FOR UPDATE;
  v_has_existing := FOUND AND v_existing.quote ? 'charge';
  IF FOUND AND NOT v_has_existing THEN
    IF v_existing.status <> 'quoted' THEN
      RETURN billing.chat_archived_charge_result(v_existing, p_user_id);
    END IF;
    v_open_quote := v_existing.id = p_charge_key;
  END IF;

  IF v_has_existing AND v_existing.status <> 'pending' THEN
    SELECT to_jsonb(w.*) INTO v_wallet_json
    FROM billing.user_wallets w
    WHERE w.user_id = v_existing.user_id
    FOR UPDATE;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', v_wallet_json,
      'charge', billing.chat_charge_json(v_existing)
    );
  END IF;

  v_quote_metadata := CASE
    WHEN NOT v_has_existing THEN '{}'::JSONB
    ELSE COALESCE(v_existing.quote -> 'charge' -> 'metadata', '{}'::JSONB)
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
    -- free_quota* stay for 1654 stale pending charges from before 6b-1q (newest 2026-09-29).
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
      'charge', billing.chat_charge_json(v_existing)
    );
  END IF;

  v_stored := CASE
    WHEN NOT v_has_existing THEN v_metadata
    ELSE COALESCE(v_existing.quote -> 'charge' -> 'metadata', '{}'::JSONB) || (
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
      v_debit_key := v_existing.id::TEXT;
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

    UPDATE billing.usage_charges
    SET generation_id = COALESCE(p_generation_id, generation_id),
        status = CASE
          WHEN v_non_billable_fixed THEN 'failed'
          WHEN v_amount = 0 THEN 'free'
          ELSE 'charged'
        END,
        charged_credits = v_amount,
        debit_ledger_id = COALESCE(v_ledger_id, debit_ledger_id),
        billing_mode = COALESCE(v_stored ->> 'billing_mode', billing_mode),
        quote = quote || jsonb_build_object('charge', (quote -> 'charge') || jsonb_build_object(
          'model_openrouter_id', p_model_openrouter_id,
          'model_display_name', p_model_display_name,
          'calculated_amount', v_amount,
          'fallback_used', false,
          'metadata', v_stored,
          'reconciled_at', now())),
        updated_at = now()
    WHERE id = v_existing.id
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

      v_status := CASE
        WHEN v_pending THEN 'pending'
        WHEN v_fixed AND v_non_billable_fixed THEN 'failed'
        WHEN v_amount = 0 THEN 'free'
        ELSE 'charged'
      END;
      v_recorded := v_amount;
      -- Only free-model failures are represented as failed spending details
      -- (formerly the BEFORE INSERT trigger on llm_usage_charges).
      IF p_model_markup = 0 AND COALESCE(v_stored ->> 'chat_status', 'success') <> 'success' THEN
        v_status := 'failed';
        v_recorded := 0;
        v_stored := v_stored || jsonb_build_object(
          'billing_mode', 'failed_free',
          'difference_reason', 'generation_failed'
        );
      END IF;
      v_stored := jsonb_build_object(
        'model_id', p_model_id, 'model_openrouter_id', p_model_openrouter_id,
        'model_display_name', p_model_display_name,
        'catalog_version', COALESCE(p_catalog_version, 0),
        'pricing_config_version', COALESCE(p_pricing_config_version, 0),
        'exchange_rate', p_exchange_rate::numeric(14,4), 'model_markup', p_model_markup::numeric(4,1),
        'initial_amount', v_recorded, 'calculated_amount', v_recorded, 'fallback_used', false,
        'metadata', v_stored, 'reconciled_at', NULL, 'charged_at', now());

      IF v_open_quote THEN
        UPDATE billing.usage_charges
        SET status = v_status,
            charged_credits = v_recorded,
            debit_ledger_id = v_ledger_id,
            generation_id = COALESCE(p_generation_id, generation_id),
            billing_mode = COALESCE(v_stored -> 'metadata' ->> 'billing_mode', billing_mode),
            quote = quote || jsonb_build_object('charge', v_stored),
            updated_at = now()
        WHERE id = p_charge_key
        RETURNING * INTO v_charge;
      ELSE
        INSERT INTO billing.usage_charges (
          id, user_id, kind, status, charged_credits, debit_ledger_id, generation_id,
          billing_mode, quote, created_at, updated_at
        ) VALUES (
          p_charge_key, p_user_id, 'chat_text', v_status, v_recorded, v_ledger_id, p_generation_id,
          v_stored -> 'metadata' ->> 'billing_mode', jsonb_build_object('charge', v_stored), now(), now()
        ) RETURNING * INTO v_charge;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        -- This subtransaction has rolled back its debit. Return only durable proof of the winner.
        SELECT * INTO v_existing
        FROM billing.usage_charges
        WHERE kind = 'chat_text'
          AND (id = p_charge_key OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id))
        ORDER BY (quote ? 'charge') DESC, (status <> 'quoted') DESC, (id = p_charge_key) DESC
        LIMIT 1;
        IF FOUND AND v_existing.quote ? 'charge' THEN
          IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
            RAISE EXCEPTION 'LLM charge owner mismatch' USING ERRCODE='22023';
          END IF;
          SELECT to_jsonb(w.*) INTO v_wallet_json FROM billing.user_wallets w
          WHERE w.user_id=v_existing.user_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'Existing LLM charge wallet missing'; END IF;
          RETURN jsonb_build_object(
            'charge_status',CASE WHEN v_existing.status='pending' THEN 'already_pending' ELSE 'already_charged' END,
            'wallet',v_wallet_json,'charge',billing.chat_charge_json(v_existing));
        ELSIF FOUND AND v_existing.status <> 'quoted' THEN
          RETURN billing.chat_archived_charge_result(v_existing, p_user_id);
        END IF;
        -- An unrelated uniqueness failure is an error, not a successful empty result.
        RAISE;
    END;
  END IF;

  PERFORM billing.grant_character_creator_reward(v_charge);

  RETURN jsonb_build_object(
    'charge_status', v_charge.status,
    'wallet', v_wallet_json,
    'charge', billing.chat_charge_json(v_charge)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION billing.apply_wallet_debit(p_user_id uuid, p_debit_key text, p_policy text, p_amount numeric, p_entry_type text, p_reference_type text, p_reference_id text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_wallet billing.user_wallets;
  v_existing billing.wallet_ledger;
  v_amount NUMERIC(14,1);
  v_main NUMERIC(14,1);
  v_bonus NUMERIC(14,1);
  v_ledger_id UUID;
  v_debit_key TEXT;
  v_reference_id TEXT;
BEGIN
  v_debit_key := btrim(COALESCE(p_debit_key, ''));
  v_reference_id := btrim(COALESCE(p_reference_id, v_debit_key));
  v_amount := round(COALESCE(p_amount, 0), 1);

  IF p_user_id IS NULL OR v_debit_key = '' OR v_reference_id = '' THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_amount <= 0 OR v_amount <> trunc(v_amount) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_policy IS NULL OR p_policy NOT IN ('main_only', 'main_then_bonus') THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_POLICY'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_reference_type IS NULL OR btrim(p_reference_type) = '' THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO billing.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  SELECT *
  INTO v_existing
  FROM billing.wallet_ledger
  WHERE debit_key = v_debit_key;

  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'INVALID_AMOUNT'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_debited',
      'debit_key', v_debit_key,
      'ledger_id', v_existing.id,
      'wallet', to_jsonb(v_wallet),
      'split', jsonb_build_object(
        'policy', p_policy,
        'main_credits', abs(v_existing.main_delta),
        'bonus_credits', abs(v_existing.bonus_delta),
        'total_credits', abs(v_existing.amount)
      )
    );
  END IF;

  IF p_policy = 'main_only' THEN
    IF v_wallet.main_credits < v_amount THEN
      RAISE EXCEPTION 'MAIN_CREDITS_INSUFFICIENT'
        USING ERRCODE = 'P0001';
    END IF;
    v_main := v_amount;
    v_bonus := 0;
  ELSE
    IF (v_wallet.main_credits + v_wallet.bonus_credits) < v_amount THEN
      RAISE EXCEPTION 'TOTAL_CREDITS_INSUFFICIENT'
        USING ERRCODE = 'P0001';
    END IF;
    -- 专项星尘（bonus）优先，不足部分再扣通用星尘（main）。
    v_bonus := LEAST(v_wallet.bonus_credits, v_amount);
    v_main := v_amount - v_bonus;
  END IF;

  IF v_main + v_bonus <> v_amount THEN
    RAISE EXCEPTION 'INVALID_WALLET_SPLIT'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    UPDATE billing.user_wallets
    SET
      main_credits = billing.user_wallets.main_credits - v_main,
      bonus_credits = billing.user_wallets.bonus_credits - v_bonus,
      updated_at = now()
    WHERE user_id = p_user_id
    RETURNING * INTO v_wallet;

    INSERT INTO billing.wallet_ledger (
      user_id,
      entry_type,
      amount,
      main_delta,
      bonus_delta,
      balance_main,
      balance_bonus,
      reference_type,
      reference_id,
      metadata,
      debit_key
    ) VALUES (
      p_user_id,
      p_entry_type,
      -v_amount,
      -v_main,
      -v_bonus,
      v_wallet.main_credits,
      v_wallet.bonus_credits,
      btrim(p_reference_type),
      v_reference_id,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'policy', p_policy,
        'debit_key', v_debit_key
      ),
      v_debit_key
    )
    RETURNING id INTO v_ledger_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT *
      INTO v_existing
      FROM billing.wallet_ledger
      WHERE debit_key = v_debit_key;
      IF NOT FOUND OR v_existing.user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'INVALID_AMOUNT'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'already_debited',
        'debit_key', v_debit_key,
        'ledger_id', v_existing.id,
        'wallet', to_jsonb(v_wallet),
        'split', jsonb_build_object(
          'policy', p_policy,
          'main_credits', abs(v_existing.main_delta),
          'bonus_credits', abs(v_existing.bonus_delta),
          'total_credits', abs(v_existing.amount)
        )
      );
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'debited',
    'debit_key', v_debit_key,
    'ledger_id', v_ledger_id,
    'wallet', to_jsonb(v_wallet),
    'split', jsonb_build_object(
      'policy', p_policy,
      'main_credits', v_main,
      'bonus_credits', v_bonus,
      'total_credits', v_amount
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION experience.list_chat_settlement_candidates(p_scan text, p_since timestamp with time zone, p_limit integer, p_identity_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamp with time zone, delivery_provider text, generation_id text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    uc.quote -> 'snapshot', uc.settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  -- db reorg 6b-1b: quote and settlement live in billing.usage_charges. A turn without a charge id never settles
  -- (reconcileCharge skips it), so it no longer takes a slot of the scan budget.
  JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id
  LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  WHERE h.created_at >= p_since
    AND uc.quote ? 'snapshot'
    AND uc.settled_at IS NULL
    AND CASE
      WHEN p_scan IN ('openrouter', 'venice') THEN
        h.status <> 'streaming' AND a.provider = p_scan AND a.generation_id IS NOT NULL
      WHEN p_scan = 'surplus' THEN
        h.status <> 'streaming' AND uc.quote -> 'snapshot' ->> 'provider' = 'surplus'
      WHEN p_scan = 'missing_identity' THEN
        a.generation_id IS NULL AND h.created_at < p_identity_before
      ELSE false
    END
  ORDER BY h.created_at, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$function$;

CREATE OR REPLACE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r experience.chat_generation_requests%ROWTYPE; h experience.chat_history%ROWTYPE; v_snapshot jsonb;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0
  JOIN experience.chat_history h0 ON h0.id=r0.chat_history_id
  WHERE h0.llm_charge_id=p_charge_key FOR UPDATE OF r0;
  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
  -- db reorg 6b-1b: the frozen quote is read from billing.usage_charges, the row p_charge_key names.
  SELECT u.quote -> 'snapshot' INTO v_snapshot FROM billing.usage_charges u WHERE u.id = p_charge_key;
  IF r.recoverable_delivery THEN
    SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
    -- server-facts-delivery-v1: only a failure the server declared can waive a reply.
    -- client_delivery_failed now means a relayed server failure; older rows keep their waiver.
    IF r.client_delivery_failed OR r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
       OR h.llm_finish_reason='timeout'
      THEN RETURN 'waived'; END IF;
    IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
       AND v_snapshot->>'charge_id'=p_charge_key::text
       AND v_snapshot->>'billing_mode'='fixed_tier'
       AND jsonb_typeof(v_snapshot->'payable_credits')='number'
      THEN RETURN 'user_stopped'; END IF;
    IF r.client_outcome='missing' THEN
      IF clock_timestamp() >= r.request_received_at + make_interval(secs=>r.first_token_deadline_ms::double precision/1000+15) THEN RETURN 'waived'; END IF;
      RETURN 'pending';
    END IF;
    -- A durable complete reply belongs to the user even if they left before reading it.
    IF h.status='success' AND h.llm_finish_reason='stop' AND length(btrim(COALESCE(h.assistant_reply,'')))>0
       AND r.delivery_attempt_id IS NOT NULL AND r.server_first_token_ready_ms < r.first_token_deadline_ms
      THEN RETURN 'visible'; END IF;
    IF h.status <> 'streaming' THEN RETURN 'waived'; END IF;
    RETURN 'pending';
  END IF;
  -- A system cutoff cannot become chargeable through a competing stop click.
  IF r.first_token_timeout OR r.server_timeout_stage IN ('global','primary','fallback')
     OR r.client_outcome='timed_out'
     OR (r.client_outcome='not_observed' AND r.client_reason IN
       ('server_timeout','primary_timeout','fallback_timeout')) THEN RETURN 'waived'; END IF;
  SELECT * INTO h FROM experience.chat_history WHERE id=r.chat_history_id;
  IF h.llm_finish_reason='user_cancelled' AND r.user_stop_billing_enabled AND NOT r.billing_rejected
     AND v_snapshot->>'charge_id'=p_charge_key::text
     AND v_snapshot->>'billing_mode'='fixed_tier'
     AND jsonb_typeof(v_snapshot->'payable_credits')='number'
    THEN RETURN 'user_stopped'; END IF;
  IF r.client_outcome='observed' AND r.client_first_token_visible_ms IS NOT NULL
     AND r.client_first_token_visible_ms < r.first_token_deadline_ms THEN RETURN 'visible'; END IF;
  IF r.client_outcome IN ('timed_out','not_observed')
     OR clock_timestamp() >= r.request_received_at
       + make_interval(secs => r.first_token_deadline_ms::double precision / 1000 + 15)
    THEN RETURN 'waived'; END IF;
  RETURN 'pending';
END;
$function$;

CREATE OR REPLACE FUNCTION billing.record_chat_turn_charge(p_history_id uuid, p_charged_credits numeric, p_quoted_credits numeric, p_settled_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  h record;
BEGIN
  SELECT id, user_id, status, llm_charge_id, created_at INTO h FROM experience.chat_history WHERE id = p_history_id;
  -- 没有计费编号的轮次（开轮前被拒、失败路径清了编号）不记计费结果。
  IF NOT FOUND OR h.llm_charge_id IS NULL THEN
    RETURN;
  END IF;
  -- null 参数不改。有扣费明细（quote.charge）的行，状态与实扣以扣费函数为准；
  -- 没有的由轮次结果定：未结算 quoted、成功 free、其余 failed。
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, subject_id, status, quoted_credits, charged_credits, settled_at, created_at, updated_at)
  VALUES (h.llm_charge_id, h.user_id, 'chat_text', h.id,
    CASE WHEN p_settled_at IS NULL THEN 'quoted' WHEN h.status = 'success' THEN 'free' ELSE 'failed' END,
    p_quoted_credits, COALESCE(p_charged_credits, 0), p_settled_at, h.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    subject_id = COALESCE(u.subject_id, EXCLUDED.subject_id),
    quoted_credits = COALESCE(EXCLUDED.quoted_credits, u.quoted_credits),
    status = CASE
      WHEN u.quote ? 'charge' THEN u.status
      WHEN COALESCE(EXCLUDED.settled_at, u.settled_at) IS NULL THEN 'quoted'
      WHEN h.status = 'success' THEN 'free'
      ELSE 'failed'
    END,
    charged_credits = CASE WHEN u.quote ? 'charge' THEN u.charged_credits ELSE COALESCE(p_charged_credits, u.charged_credits) END,
    settled_at = COALESCE(EXCLUDED.settled_at, u.settled_at),
    updated_at = now();
END
$function$;

CREATE OR REPLACE FUNCTION billing.save_chat_turn_quote(p_history_id uuid, p_snapshot jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  h record;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid billing snapshot' USING ERRCODE = '22023';
  END IF;
  SELECT id, user_id, llm_charge_id, created_at INTO h FROM experience.chat_history WHERE id = p_history_id;
  -- 报价跟着这一轮的计费编号走；没有编号的轮次（失败路径清了编号）不再落报价。
  IF NOT FOUND OR h.llm_charge_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO billing.usage_charges AS u (id, user_id, kind, subject_id, status, quote, created_at, updated_at)
  VALUES (h.llm_charge_id, h.user_id, 'chat_text', h.id, 'quoted', jsonb_build_object('snapshot', p_snapshot), h.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    subject_id = COALESCE(u.subject_id, EXCLUDED.subject_id),
    quote = u.quote || EXCLUDED.quote,
    updated_at = now();
END
$function$;

CREATE OR REPLACE FUNCTION experience.begin_chat_generation_observation(p_history_id uuid, p_input jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  h experience.chat_history%ROWTYPE;
  v_fallback text := COALESCE(p_input->>'fallback_model_id','deepseek/deepseek-v4.1-flash');
  v_charge_id uuid := (p_input->>'charge_id')::uuid;
  v_request_id uuid := (p_input->>'request_id')::uuid;
  v_history jsonb := p_input->'history';
BEGIN
  IF (p_input ? 'fallback_model_id' AND jsonb_typeof(p_input->'fallback_model_id') IS DISTINCT FROM 'string')
     OR length(v_fallback) > 200
     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN
    RAISE EXCEPTION 'Invalid frozen fallback model ID' USING ERRCODE='22023';
  END IF;
  IF p_input->>'measurement_method' IS NOT NULL AND p_input->>'measurement_method' <> 'client_committed_v4' THEN
    RAISE EXCEPTION 'Invalid client measurement method' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'charge_id' AND v_charge_id IS NULL THEN
    RAISE EXCEPTION 'Invalid generation charge identity' USING ERRCODE='22023';
  END IF;
  IF p_input ? 'history' THEN
    IF jsonb_typeof(v_history) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid generation history' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(v_history) = 0 OR v_request_id IS NULL
       OR (v_history#>>'{0,request_id}')::uuid IS DISTINCT FROM v_request_id
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_history) AS item
         WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR COALESCE(item->>'role','') NOT IN ('system','user','assistant')
           OR jsonb_typeof(item->'content') IS DISTINCT FROM 'string'
       ) THEN
      RAISE EXCEPTION 'Generation history identity or message shape differs' USING ERRCODE='22023';
    END IF;
  END IF;

  IF p_input ? 'history' AND NOT (p_input ? 'snapshot')
     AND (jsonb_array_length(v_history) <> 1 OR v_history#>>'{0,role}' <> 'system' OR v_history#>>'{0,content}' <> '') THEN
    RAISE EXCEPTION 'Initial generation history must contain only its request marker' USING ERRCODE='22023';
  END IF;

  -- One PK row lock arbitrates admission/freeze against cancellation and terminal writes.
  SELECT * INTO STRICT h FROM experience.chat_history WHERE id=p_history_id FOR UPDATE;
  IF h.status <> 'streaming' OR h.llm_finish_reason IS NOT NULL
     OR (v_charge_id IS NOT NULL AND h.llm_charge_id IS NOT NULL AND h.llm_charge_id <> v_charge_id)
     OR (p_input ? 'snapshot' AND COALESCE(h.llm_charge_id,v_charge_id)::text IS DISTINCT FROM p_input#>>'{snapshot,charge_id}') THEN
    RAISE EXCEPTION 'Generation is no longer active or charge identity differs' USING ERRCODE='PT409';
  END IF;
  IF p_input ? 'history' AND EXISTS (
       SELECT 1 FROM experience.chat_history_display_metadata m
       WHERE m.history_id=p_history_id AND m.request_id IS NOT NULL
         AND m.request_id::uuid IS DISTINCT FROM v_request_id) THEN
    RAISE EXCEPTION 'Stored generation request identity differs' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id)
     AND NOT EXISTS (
       SELECT 1 FROM experience.chat_generation_requests
       WHERE chat_history_id=p_history_id AND client_request_id=v_request_id
         AND (NOT (p_input ? 'fallback_model_id') OR fallback_model_id=v_fallback)
         AND fallback_timeout_ms IS NOT DISTINCT FROM (p_input->>'fallback_timeout_ms')::integer
         AND (p_input->>'measurement_method' IS NULL OR measurement_method=p_input->>'measurement_method')
     ) THEN
    RAISE EXCEPTION 'Generation request identity conflict' USING ERRCODE='22023';
  END IF;

  IF p_input ? 'history' OR v_charge_id IS NOT NULL OR p_input ? 'snapshot' THEN
    -- chat_display_projection_v1
    IF p_input ? 'history' AND (p_input ? 'snapshot' OR NOT EXISTS (SELECT 1 FROM billing.usage_charges u WHERE u.id=h.llm_charge_id AND u.quote ? 'snapshot')) THEN
      UPDATE experience.chat_history SET
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id)
      WHERE id=p_history_id;
      -- db reorg 6b-1c: the frozen quote lives in billing.usage_charges.quote.snapshot.
      IF p_input ? 'snapshot' THEN PERFORM billing.save_chat_turn_quote(p_history_id,p_input->'snapshot'); END IF;
      -- Derive only from the input actually accepted above, never from the stored TOAST value.
      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message)
      SELECT p_history_id,d.request_id,d.opening_message FROM experience.extract_chat_history_display(v_history) d
      WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
      ON CONFLICT(history_id) DO UPDATE SET request_id=excluded.request_id,
        opening_message=excluded.opening_message;
    ELSE
      -- No history assignment: initial replay cannot erase the opening or invalidate its projection.
      UPDATE experience.chat_history SET llm_charge_id=COALESCE(v_charge_id,llm_charge_id)
      WHERE id=p_history_id;
      -- db reorg 6b-1c: the frozen quote lives in billing.usage_charges.quote.snapshot.
      IF p_input ? 'snapshot' THEN PERFORM billing.save_chat_turn_quote(p_history_id,p_input->'snapshot'); END IF;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM experience.chat_generation_requests WHERE chat_history_id=p_history_id) THEN RETURN; END IF;
  INSERT INTO experience.chat_generation_requests(chat_history_id,client_request_id,mode,request_received_at,requested_model_id,requested_provider,requested_provider_model_id,catalog_version,primary_timeout_ms,first_token_deadline_ms,timeout_rate_target,fallback_model_id,fallback_timeout_ms,recoverable_delivery,measurement_method)
  VALUES(p_history_id,v_request_id,p_input->>'mode',(p_input->>'received_at')::timestamptz,p_input->>'requested_model_id',p_input->>'provider',p_input->>'model',(p_input->>'catalog_version')::integer,(p_input->>'timeout_ms')::integer,(p_input->>'deadline_ms')::integer,(p_input->>'timeout_rate_target')::numeric,v_fallback,(p_input->>'fallback_timeout_ms')::integer,COALESCE((p_input->>'recoverable_delivery')::boolean,false),p_input->>'measurement_method');
  INSERT INTO experience.chat_generation_attempts(id,chat_history_id,role,provider,provider_model_id)
  VALUES((p_input->>'primary_attempt_id')::uuid,p_history_id,'primary',p_input->>'provider',p_input->>'model');
END;
$function$;

CREATE OR REPLACE FUNCTION experience.list_llm_call_metadata_gaps(p_since timestamp with time zone, p_limit integer)
 RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamp with time zone, delivery_provider text, generation_id text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  -- db reorg 6a-2c-3: a gap is a missing cost or usage. finish_reason / latency / generation_time are optional
  -- (OpenRouter never returns them for some generations), so they no longer keep a turn in the scan forever.
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    uc.quote -> 'snapshot', uc.settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  -- db reorg 6b-1b: quote and settlement live in billing.usage_charges.
  LEFT JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id
  JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  LEFT JOIN ops.llm_calls l ON l.id = a.id
  WHERE h.created_at >= p_since
    AND h.status <> 'streaming'
    AND a.provider = 'openrouter'
    AND a.generation_id IS NOT NULL
    AND (l.id IS NULL OR l.raw_usage IS NULL OR l.cost_usd IS NULL)
  ORDER BY h.created_at DESC, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$function$;

