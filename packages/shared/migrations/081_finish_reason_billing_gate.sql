-- 081_finish_reason_billing_gate.sql
-- Only natural LLM completions (finish_reason=stop) may debit stardust.

BEGIN;

CREATE OR REPLACE FUNCTION miniapp.charge_llm_usage(
  p_charge_key UUID,
  p_generation_id TEXT,
  p_user_id UUID,
  p_model_id TEXT,
  p_model_openrouter_id TEXT,
  p_model_display_name TEXT,
  p_catalog_version INTEGER,
  p_pricing_config_version INTEGER,
  p_usage_cost_usd NUMERIC,
  p_exchange_rate NUMERIC,
  p_model_markup NUMERIC,
  p_calculated_amount NUMERIC,
  p_fallback_used BOOLEAN,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_existing miniapp.llm_usage_charges;
  v_metadata JSONB := COALESCE(p_metadata, '{}'::JSONB);
  v_fixed BOOLEAN := COALESCE(v_metadata ->> 'billing_mode', '') = 'fixed_tier';
  v_chat_status TEXT := COALESCE(v_metadata ->> 'chat_status', 'success');
  v_finish_reason TEXT := v_metadata ->> 'finish_reason';
  v_waiting_finish BOOLEAN := v_fixed
    AND v_chat_status = 'success'
    AND v_finish_reason IS NULL;
  v_non_billable_fixed BOOLEAN := v_fixed
    AND NOT v_waiting_finish
    AND (v_chat_status <> 'success' OR v_finish_reason <> 'stop');
  v_pending BOOLEAN := CASE
    WHEN v_fixed THEN v_waiting_finish
    ELSE p_model_markup > 0
      AND (COALESCE(p_fallback_used, false) OR p_usage_cost_usd IS NULL)
  END;
  -- Fixed-tier rows are charged only after finish_reason=stop. Null waits for
  -- the sync job; every other terminal reason is retained as a 0-stardust row.
  v_amount NUMERIC(14,1) := CASE
    WHEN v_fixed AND (v_waiting_finish OR v_non_billable_fixed) THEN 0
    WHEN v_fixed THEN round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
    WHEN p_model_markup = 0 OR v_pending THEN 0
    ELSE round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
  END;
  v_available NUMERIC(14,1);
  v_charged NUMERIC(14,1);
  v_bonus_to_deduct NUMERIC(14,1);
  v_main_to_deduct NUMERIC(14,1);
  v_ledger_id UUID;
  v_charge miniapp.llm_usage_charges;
  v_billing_gate TEXT := CASE
    WHEN v_fixed AND v_waiting_finish THEN 'pending_finish_reason'
    WHEN v_fixed AND v_non_billable_fixed THEN 'non_billable'
    WHEN v_fixed THEN 'billable'
    WHEN p_model_markup = 0 THEN 'free'
    WHEN v_pending THEN 'deferred'
    ELSE 'actual_usage'
  END;
  v_difference_reason TEXT := CASE
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
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL
     OR COALESCE(trim(p_model_openrouter_id), '') = ''
     OR COALESCE(trim(p_model_display_name), '') = ''
     OR p_exchange_rate <= 0 OR p_model_markup < 0 THEN
    RAISE EXCEPTION 'invalid LLM usage charge input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM miniapp.llm_usage_charges
  WHERE charge_key = p_charge_key
     OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
  ORDER BY (charge_key = p_charge_key) DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    SELECT * INTO v_wallet
    FROM miniapp.user_wallets
    WHERE user_id = v_existing.user_id
    FOR UPDATE;

    IF v_fixed AND v_existing.status = 'pending' THEN
      IF v_waiting_finish THEN
        RETURN jsonb_build_object(
          'charge_status', 'already_pending',
          'wallet', to_jsonb(v_wallet),
          'charge', to_jsonb(v_existing)
        );
      END IF;

      v_available := v_wallet.main_credits + v_wallet.bonus_credits;
      v_charged := LEAST(v_amount, v_available);
      v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, v_charged);
      v_main_to_deduct := v_charged - v_bonus_to_deduct;

      IF v_charged > 0 THEN
        UPDATE miniapp.user_wallets
        SET bonus_credits = bonus_credits - v_bonus_to_deduct,
            main_credits = main_credits - v_main_to_deduct,
            updated_at = now()
        WHERE user_id = v_existing.user_id
        RETURNING * INTO v_wallet;

        INSERT INTO miniapp.wallet_ledger(
          user_id, entry_type, amount, main_delta, bonus_delta,
          balance_main, balance_bonus, reference_type, reference_id, metadata
        ) VALUES (
          v_existing.user_id, 'chat_debit', -v_charged, -v_main_to_deduct, -v_bonus_to_deduct,
          v_wallet.main_credits, v_wallet.bonus_credits, 'llm_usage', v_existing.charge_key::TEXT,
          COALESCE(v_existing.metadata, '{}'::JSONB) || v_metadata || jsonb_build_object(
            'generation_id', COALESCE(p_generation_id, v_existing.generation_id),
            'model', p_model_openrouter_id,
            'calculated_amount', v_amount,
            'billing_mode', 'fixed_tier',
            'billing_gate', v_billing_gate
          )
        ) RETURNING id INTO v_ledger_id;
      END IF;

      UPDATE miniapp.llm_usage_charges
      SET generation_id = COALESCE(p_generation_id, generation_id),
          model_openrouter_id = p_model_openrouter_id,
          model_display_name = p_model_display_name,
          usage_cost_usd = p_usage_cost_usd,
          calculated_amount = v_amount,
          charged_amount = v_charged,
          fallback_used = false,
          status = CASE
            WHEN v_non_billable_fixed THEN 'failed'
            WHEN v_amount = 0 THEN 'free'
            WHEN v_charged = v_amount THEN 'charged'
            ELSE 'partial'
          END,
          debit_ledger_id = v_ledger_id,
          metadata = COALESCE(metadata, '{}'::JSONB) || v_metadata || jsonb_build_object(
            'billing_mode', 'fixed_tier',
            'billing_gate', v_billing_gate,
            'finish_reason', v_finish_reason,
            'difference_reason', CASE
              WHEN v_charged < v_amount THEN 'insufficient_balance'
              ELSE v_difference_reason
            END,
            'available_balance_before', v_available
          ),
          reconciled_at = now()
      WHERE charge_key = v_existing.charge_key
      RETURNING * INTO v_charge;

      RETURN jsonb_build_object(
        'charge_status', v_charge.status,
        'wallet', to_jsonb(v_wallet),
        'charge', to_jsonb(v_charge)
      );
    END IF;

    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet),
      'charge', to_jsonb(v_existing)
    );
  END IF;

  INSERT INTO miniapp.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_wallet
  FROM miniapp.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_available := v_wallet.main_credits + v_wallet.bonus_credits;
  v_charged := LEAST(v_amount, v_available);
  v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, v_charged);
  v_main_to_deduct := v_charged - v_bonus_to_deduct;

  IF v_charged > 0 THEN
    UPDATE miniapp.user_wallets
    SET bonus_credits = bonus_credits - v_bonus_to_deduct,
        main_credits = main_credits - v_main_to_deduct,
        updated_at = now()
    WHERE user_id = p_user_id
    RETURNING * INTO v_wallet;

    INSERT INTO miniapp.wallet_ledger(
      user_id, entry_type, amount, main_delta, bonus_delta,
      balance_main, balance_bonus, reference_type, reference_id, metadata
    ) VALUES (
      p_user_id, 'chat_debit', -v_charged, -v_main_to_deduct, -v_bonus_to_deduct,
      v_wallet.main_credits, v_wallet.bonus_credits, 'llm_usage', p_charge_key::TEXT,
      v_metadata || jsonb_build_object(
        'generation_id', p_generation_id,
        'model', p_model_openrouter_id,
        'calculated_amount', v_amount,
        'billing_mode', CASE WHEN v_fixed THEN 'fixed_tier' ELSE 'actual_usage' END,
        'billing_gate', v_billing_gate
      )
    ) RETURNING id INTO v_ledger_id;
  END IF;

  INSERT INTO miniapp.llm_usage_charges(
    charge_key, generation_id, user_id, model_id, model_openrouter_id,
    model_display_name, catalog_version, pricing_config_version,
    usage_cost_usd, exchange_rate, model_markup, initial_amount,
    calculated_amount, charged_amount, fallback_used, status,
    debit_ledger_id, metadata
  ) VALUES (
    p_charge_key, p_generation_id, p_user_id, p_model_id, p_model_openrouter_id,
    p_model_display_name, COALESCE(p_catalog_version, 0),
    COALESCE(p_pricing_config_version, 0), p_usage_cost_usd, p_exchange_rate,
    p_model_markup, v_amount, v_amount, v_charged, false,
    CASE
      WHEN v_pending THEN 'pending'
      WHEN v_fixed AND v_non_billable_fixed THEN 'failed'
      WHEN (v_fixed OR p_model_markup = 0) AND v_amount = 0 THEN 'free'
      WHEN v_charged = v_amount THEN 'charged'
      ELSE 'partial'
    END,
    v_ledger_id, v_metadata || jsonb_build_object(
      'billing_mode', CASE
        WHEN v_fixed THEN 'fixed_tier'
        WHEN p_model_markup = 0 THEN 'free'
        WHEN v_pending THEN 'deferred'
        ELSE 'actual_usage'
      END,
      'billing_gate', v_billing_gate,
      'finish_reason', v_finish_reason,
      'difference_reason', CASE
        WHEN v_charged < v_amount THEN 'insufficient_balance'
        ELSE v_difference_reason
      END,
      'available_balance_before', v_available,
      'legacy_fallback_candidate', CASE
        WHEN NOT v_fixed AND v_pending THEN round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
        ELSE NULL
      END
    )
  ) RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'charge_status', v_charge.status,
    'wallet', to_jsonb(v_wallet),
    'charge', to_jsonb(v_charge)
  );
END;
$$;

COMMENT ON FUNCTION miniapp.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) IS
  'Idempotently records LLM billing. Fixed-tier calls debit only when finish_reason=stop; null remains pending and other terminal reasons become 0-stardust details.';

NOTIFY pgrst, 'reload schema';

COMMIT;
