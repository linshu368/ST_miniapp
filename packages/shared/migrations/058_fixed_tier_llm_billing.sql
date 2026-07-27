-- Fixed per-round LLM deductions configured through llm_pricing_config.

BEGIN;

INSERT INTO miniapp.runtime_config (
  key, value, description, version, updated_at, text_value
) VALUES (
  'llm_pricing_config',
  '{
    "balanceBaseline": 30,
    "fallbackCost": 30,
    "exchangeRate": 680,
    "markup": 2.5,
    "fixedDeduction": {
      "freeQuotaExhausted": 10,
      "standard": 30,
      "premium": 50
    }
  }'::JSONB,
  'LLM 固定扣费：免费模型单卡 50 轮后 10 星尘，标准档 30 星尘，旗舰档 50 星尘。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  value = COALESCE(miniapp.runtime_config.value, '{}'::JSONB)
    || jsonb_build_object('fixedDeduction', EXCLUDED.value -> 'fixedDeduction'),
  description = EXCLUDED.description,
  version = COALESCE(miniapp.runtime_config.version, 0) + 1,
  updated_at = now(),
  text_value = NULL;

CREATE OR REPLACE FUNCTION admin.validate_fixed_llm_deduction_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'fixedDeduction') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'freeQuotaExhausted')
        IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'standard') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'premium') IS DISTINCT FROM 'number'
     OR (p_value #>> '{fixedDeduction,freeQuotaExhausted}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,standard}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,premium}')::NUMERIC < 0 THEN
    RAISE EXCEPTION
      'llm_pricing_config.fixedDeduction must include nonnegative freeQuotaExhausted, standard and premium amounts'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NOT NULL
     AND to_regprocedure('admin.validate_managed_config_value_before_fixed_billing(text,jsonb,text)')
        IS NULL THEN
    ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
      RENAME TO validate_managed_config_value_before_fixed_billing;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.validate_managed_config_value_before_fixed_billing(
    p_config_key,
    p_value,
    p_text_value
  );
  IF p_config_key = 'llm_pricing_config' THEN
    PERFORM admin.validate_fixed_llm_deduction_config(p_value);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_fixed_llm_deduction_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_fixed BOOLEAN := COALESCE(p_metadata ->> 'billing_mode', '') = 'fixed_tier';
  v_pending BOOLEAN := NOT v_fixed
    AND p_model_markup > 0
    AND (COALESCE(p_fallback_used, false) OR p_usage_cost_usd IS NULL);
  -- Fixed-tier charges use the precomputed amount directly. Legacy usage billing
  -- still treats markup=0 as free and missing usage as pending.
  v_amount NUMERIC(14,1) := CASE
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
  v_billing_mode TEXT := CASE
    WHEN v_fixed THEN 'fixed_tier'
    WHEN p_model_markup = 0 THEN 'free'
    WHEN v_pending THEN 'deferred'
    ELSE 'actual_usage'
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
        'billing_mode', v_billing_mode
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
      WHEN v_fixed AND v_amount = 0 THEN 'free'
      WHEN NOT v_fixed AND p_model_markup = 0 THEN 'free'
      WHEN v_pending THEN 'pending'
      WHEN v_charged = v_amount THEN 'charged'
      ELSE 'partial'
    END,
    v_ledger_id, COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
      'billing_mode', v_billing_mode,
      'difference_reason', CASE
        WHEN v_fixed AND v_amount = 0 THEN 'free_model'
        WHEN NOT v_fixed AND p_model_markup = 0 THEN 'free_model'
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

COMMENT ON FUNCTION admin.validate_fixed_llm_deduction_config(JSONB) IS
  'Validate fixed per-round LLM deduction amounts in llm_pricing_config.';
COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Validate managed runtime config, including fixed per-round LLM deductions.';
COMMENT ON FUNCTION miniapp.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) IS
  'Idempotently charges fixed-tier requests immediately while retaining legacy deferred usage billing.';

COMMIT;
