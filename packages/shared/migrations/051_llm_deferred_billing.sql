-- 051_llm_deferred_billing.sql
-- Record calls with unavailable OpenRouter usage as pending without charging.
-- This remains compatible with pre-051 backends that pass fallback_used=true.

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'miniapp.llm_usage_charges'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format(
      'ALTER TABLE miniapp.llm_usage_charges DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;

  ALTER TABLE miniapp.llm_usage_charges
    ADD CONSTRAINT llm_usage_charges_status_check CHECK (
      status IN ('pending', 'free', 'charged', 'partial', 'reconciled', 'historical')
    );
END;
$$;

CREATE INDEX IF NOT EXISTS idx_llm_usage_charges_pending_created
  ON miniapp.llm_usage_charges(created_at)
  WHERE status = 'pending';

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
  v_pending BOOLEAN := p_model_markup > 0
    AND (COALESCE(p_fallback_used, false) OR p_usage_cost_usd IS NULL);
  v_amount NUMERIC(14,1) := CASE
    WHEN p_model_markup = 0 OR v_pending THEN 0
    ELSE round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
  END;
  v_available NUMERIC(14,1);
  v_charged NUMERIC(14,1);
  v_bonus_to_deduct NUMERIC(14,1);
  v_main_to_deduct NUMERIC(14,1);
  v_ledger_id UUID;
  v_charge miniapp.llm_usage_charges;
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
    WHERE user_id = v_existing.user_id;
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
      COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
        'generation_id', p_generation_id,
        'model', p_model_openrouter_id,
        'calculated_amount', v_amount,
        'billing_mode', 'actual_usage'
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
      WHEN p_model_markup = 0 THEN 'free'
      WHEN v_pending THEN 'pending'
      WHEN v_charged = v_amount THEN 'charged'
      ELSE 'partial'
    END,
    v_ledger_id, COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
      'billing_mode', CASE
        WHEN p_model_markup = 0 THEN 'free'
        WHEN v_pending THEN 'deferred'
        ELSE 'actual_usage'
      END,
      'difference_reason', CASE
        WHEN p_model_markup = 0 THEN 'free_model'
        WHEN v_pending THEN 'awaiting_openrouter_usage'
        WHEN v_charged < v_amount THEN 'insufficient_balance'
        ELSE NULL
      END,
      'available_balance_before', v_available,
      'legacy_fallback_candidate', CASE
        WHEN v_pending THEN round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
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
  'Idempotently records LLM billing. Missing usage is pending with zero wallet impact; free markup is always zero.';

-- Keep the two published free models free in every environment. Updating the
-- runtime_config version invalidates version-aware backend catalog caches.
DO $$
DECLARE
  v_catalog JSONB;
  v_tier JSONB;
  v_model JSONB;
  v_tiers JSONB := '[]'::JSONB;
  v_models JSONB;
  v_changed BOOLEAN := false;
BEGIN
  SELECT value INTO v_catalog
  FROM miniapp.runtime_config
  WHERE key = 'llm_model_catalog'
  FOR UPDATE;

  IF v_catalog IS NULL OR jsonb_typeof(v_catalog -> 'tiers') <> 'array' THEN
    RETURN;
  END IF;

  FOR v_tier IN SELECT value FROM jsonb_array_elements(v_catalog -> 'tiers')
  LOOP
    v_models := '[]'::JSONB;
    FOR v_model IN
      SELECT value FROM jsonb_array_elements(COALESCE(v_tier -> 'models', '[]'::JSONB))
    LOOP
      IF v_model ->> 'id' IN ('deepseek-v3.2', 'gemini-flash-lite', 'gemini-3.1-flash-lite')
         OR v_model ->> 'openrouter_model_id' IN (
           'deepseek/deepseek-v3.2',
           'google/gemini-3.1-flash-lite'
         ) THEN
        IF COALESCE((v_model ->> 'markup')::NUMERIC, -1) <> 0
           OR COALESCE((v_model ->> 'price_input')::NUMERIC, -1) <> 0
           OR COALESCE((v_model ->> 'price_output')::NUMERIC, -1) <> 0 THEN
          v_changed := true;
        END IF;
        v_model := v_model || jsonb_build_object(
          'markup', 0,
          'price_input', 0,
          'price_output', 0
        );
      END IF;
      v_models := v_models || jsonb_build_array(v_model);
    END LOOP;
    v_tiers := v_tiers || jsonb_build_array(jsonb_set(v_tier, '{models}', v_models));
  END LOOP;

  IF v_changed THEN
    UPDATE miniapp.runtime_config
    SET value = jsonb_set(v_catalog, '{tiers}', v_tiers),
        version = COALESCE(version, 0) + 1,
        updated_at = now()
    WHERE key = 'llm_model_catalog';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
