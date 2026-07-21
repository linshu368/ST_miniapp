-- Free models, decimal wallet balances, idempotent LLM usage charges and spending details.

BEGIN;

-- Real wallet precision is one decimal place. Existing integer values retain their value.
-- Type rewrites are guarded because repeating them is expensive on hosted Postgres.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'miniapp' AND table_name = 'user_wallets'
      AND column_name = 'main_credits' AND data_type <> 'numeric'
  ) THEN
    ALTER TABLE miniapp.user_wallets DROP COLUMN IF EXISTS total_credits;
    ALTER TABLE miniapp.user_wallets
      ALTER COLUMN main_credits TYPE NUMERIC(14,1) USING main_credits::NUMERIC(14,1),
      ALTER COLUMN main_credits SET DEFAULT 0,
      ALTER COLUMN bonus_credits TYPE NUMERIC(14,1) USING bonus_credits::NUMERIC(14,1),
      ALTER COLUMN bonus_credits SET DEFAULT 0;
    ALTER TABLE miniapp.user_wallets
      ADD COLUMN total_credits NUMERIC(14,1)
      GENERATED ALWAYS AS (main_credits + bonus_credits) STORED;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'miniapp' AND table_name = 'wallet_ledger'
      AND column_name = 'amount' AND data_type <> 'numeric'
  ) THEN
    ALTER TABLE miniapp.wallet_ledger
      DROP CONSTRAINT IF EXISTS wallet_ledger_amount_check,
      DROP CONSTRAINT IF EXISTS wallet_ledger_balance_main_check,
      DROP CONSTRAINT IF EXISTS wallet_ledger_balance_bonus_check;
    ALTER TABLE miniapp.wallet_ledger
      ALTER COLUMN amount TYPE NUMERIC(14,1) USING amount::NUMERIC(14,1),
      ALTER COLUMN main_delta TYPE NUMERIC(14,1) USING main_delta::NUMERIC(14,1),
      ALTER COLUMN main_delta SET DEFAULT 0,
      ALTER COLUMN bonus_delta TYPE NUMERIC(14,1) USING bonus_delta::NUMERIC(14,1),
      ALTER COLUMN bonus_delta SET DEFAULT 0,
      ALTER COLUMN balance_main TYPE NUMERIC(14,1) USING balance_main::NUMERIC(14,1),
      ALTER COLUMN balance_bonus TYPE NUMERIC(14,1) USING balance_bonus::NUMERIC(14,1);
    ALTER TABLE miniapp.wallet_ledger
      ADD CONSTRAINT wallet_ledger_amount_check CHECK (amount <> 0),
      ADD CONSTRAINT wallet_ledger_balance_main_check CHECK (balance_main >= 0),
      ADD CONSTRAINT wallet_ledger_balance_bonus_check CHECK (balance_bonus >= 0);
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'miniapp' AND table_name = 'chat_message_charges'
      AND column_name = 'amount' AND data_type <> 'numeric'
  ) THEN
    ALTER TABLE miniapp.chat_message_charges
      DROP CONSTRAINT IF EXISTS chat_message_charges_amount_check;
    ALTER TABLE miniapp.chat_message_charges
      ALTER COLUMN amount TYPE NUMERIC(14,1) USING amount::NUMERIC(14,1);
    ALTER TABLE miniapp.chat_message_charges
      ADD CONSTRAINT chat_message_charges_amount_check CHECK (amount >= 0);
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'miniapp' AND table_name = 'chat_history'
      AND column_name = 'deduction_rate'
      AND (data_type <> 'numeric' OR numeric_scale IS DISTINCT FROM 1)
  ) THEN
    ALTER TABLE miniapp.chat_history
      ALTER COLUMN deduction_rate TYPE NUMERIC(14,1)
      USING round(COALESCE(deduction_rate, 0)::NUMERIC, 1);
  END IF;
END;
$$;

ALTER TABLE miniapp.chat_history
  ADD COLUMN IF NOT EXISTS llm_model_markup NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS llm_intended_deduction NUMERIC(14,1),
  ADD COLUMN IF NOT EXISTS llm_charge_id UUID;

CREATE TABLE IF NOT EXISTS miniapp.llm_usage_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_key UUID NOT NULL UNIQUE,
  generation_id TEXT,
  user_id UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  model_id TEXT,
  model_openrouter_id TEXT NOT NULL,
  model_display_name TEXT NOT NULL,
  catalog_version INTEGER NOT NULL DEFAULT 0,
  pricing_config_version INTEGER NOT NULL DEFAULT 0,
  usage_cost_usd NUMERIC(20,10),
  exchange_rate NUMERIC(14,4) NOT NULL,
  model_markup NUMERIC(4,1) NOT NULL CHECK (model_markup >= 0),
  initial_amount NUMERIC(14,1) NOT NULL DEFAULT 0,
  calculated_amount NUMERIC(14,1) NOT NULL DEFAULT 0,
  charged_amount NUMERIC(14,1) NOT NULL DEFAULT 0,
  fallback_used BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (
    status IN ('free', 'charged', 'partial', 'reconciled', 'historical')
  ),
  debit_ledger_id UUID REFERENCES miniapp.wallet_ledger(id),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_charges_generation
  ON miniapp.llm_usage_charges(generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_usage_charges_user_created
  ON miniapp.llm_usage_charges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_charges_model_created
  ON miniapp.llm_usage_charges(model_openrouter_id, created_at DESC);

ALTER TABLE miniapp.llm_usage_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.llm_usage_charges FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.llm_usage_charges TO service_role, postgres;

DROP FUNCTION IF EXISTS miniapp.deduct_wallet_credits(UUID, INTEGER);
DROP FUNCTION IF EXISTS miniapp.deduct_wallet_credits(UUID, NUMERIC);
CREATE FUNCTION miniapp.deduct_wallet_credits(
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS miniapp.user_wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_amount NUMERIC(14,1) := round(p_amount, 1);
  v_bonus_to_deduct NUMERIC(14,1);
  v_main_to_deduct NUMERIC(14,1);
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'deduct amount must be positive: %', p_amount
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO miniapp.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_wallet
  FROM miniapp.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_wallet.main_credits + v_wallet.bonus_credits < v_amount THEN
    RAISE EXCEPTION 'insufficient credits: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, v_amount);
  v_main_to_deduct := v_amount - v_bonus_to_deduct;

  UPDATE miniapp.user_wallets
  SET bonus_credits = bonus_credits - v_bonus_to_deduct,
      main_credits = main_credits - v_main_to_deduct,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  RETURN v_wallet;
END;
$$;

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
  v_amount NUMERIC(14,1) := CASE
    WHEN p_model_markup = 0 THEN 0
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
    SELECT * INTO v_wallet FROM miniapp.user_wallets WHERE user_id = v_existing.user_id;
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
        'fallback_used', p_fallback_used
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
    p_model_markup, v_amount, v_amount, v_charged, p_fallback_used,
    CASE
      WHEN p_model_markup = 0 THEN 'free'
      WHEN v_charged = v_amount THEN 'charged'
      ELSE 'partial'
    END,
    v_ledger_id, COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
      'billing_mode', CASE WHEN p_model_markup = 0 THEN 'free' ELSE 'paid' END,
      'difference_reason', CASE
        WHEN p_model_markup = 0 THEN 'free_model'
        WHEN v_charged < v_amount THEN 'insufficient_balance'
        ELSE NULL
      END,
      'available_balance_before', v_available
    )
  ) RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'charge_status', v_charge.status,
    'wallet', to_jsonb(v_wallet),
    'charge', to_jsonb(v_charge)
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp.reconcile_llm_usage(
  p_charge_key UUID,
  p_usage_cost_usd NUMERIC,
  p_calculated_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_charge miniapp.llm_usage_charges;
  v_wallet miniapp.user_wallets;
  v_target NUMERIC(14,1);
  v_delta NUMERIC(14,1);
  v_applied NUMERIC(14,1) := 0;
  v_bonus NUMERIC(14,1) := 0;
  v_main NUMERIC(14,1) := 0;
  v_net_bonus_debit NUMERIC(14,1);
  v_net_main_debit NUMERIC(14,1);
BEGIN
  SELECT * INTO v_charge
  FROM miniapp.llm_usage_charges
  WHERE charge_key = p_charge_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LLM usage charge not found: %', p_charge_key
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_wallet
  FROM miniapp.user_wallets
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
      UPDATE miniapp.user_wallets
      SET bonus_credits = bonus_credits - v_bonus,
          main_credits = main_credits - v_main,
          updated_at = now()
      WHERE user_id = v_charge.user_id
      RETURNING * INTO v_wallet;

      INSERT INTO miniapp.wallet_ledger(
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
    FROM miniapp.wallet_ledger
    WHERE reference_type = 'llm_usage'
      AND reference_id = v_charge.charge_key::TEXT;

    v_bonus := LEAST(v_applied, v_net_bonus_debit);
    v_main := v_applied - v_bonus;
    UPDATE miniapp.user_wallets
    SET bonus_credits = bonus_credits + v_bonus,
        main_credits = main_credits + v_main,
        updated_at = now()
    WHERE user_id = v_charge.user_id
    RETURNING * INTO v_wallet;

    INSERT INTO miniapp.wallet_ledger(
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

  UPDATE miniapp.llm_usage_charges
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
$$;

-- Preserve historical deductions as immutable detail rows without changing balances.
INSERT INTO miniapp.llm_usage_charges(
  charge_key, generation_id, user_id, model_openrouter_id, model_display_name,
  usage_cost_usd, exchange_rate, model_markup, initial_amount,
  calculated_amount, charged_amount, fallback_used, status, created_at, updated_at,
  metadata
)
SELECT
  history.id,
  history.llm_generation_id,
  history.user_id,
  COALESCE(history.llm_model, history.model),
  COALESCE(history.llm_model, history.model),
  CASE
    WHEN jsonb_typeof(history.llm_usage) = 'number'
      THEN (history.llm_usage #>> '{}')::NUMERIC
    WHEN jsonb_typeof(history.llm_usage) = 'object'
      THEN NULLIF(history.llm_usage ->> 'cost', '')::NUMERIC
    ELSE NULL
  END,
  680,
  COALESCE(history.llm_model_markup, 2.5),
  COALESCE(history.deduction_rate, 0),
  COALESCE(history.deduction_rate, 0),
  COALESCE(history.deduction_rate, 0),
  history.llm_usage IS NULL,
  'historical',
  history.created_at,
  history.created_at,
  jsonb_build_object('backfilled_from_chat_history', true)
FROM miniapp.chat_history AS history
WHERE history.status = 'success'
  AND NOT EXISTS (
    SELECT 1
    FROM miniapp.llm_usage_charges AS charge
    WHERE charge.charge_key = history.id
       OR (
         history.llm_generation_id IS NOT NULL
         AND charge.generation_id = history.llm_generation_id
       )
  )
ON CONFLICT DO NOTHING;

-- Allow free (markup 0) catalog entries and require their display prices to be zero.
CREATE OR REPLACE FUNCTION admin.validate_model_catalog_prd(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE trim(tier ->> 'label') = ''
      OR char_length(trim(tier ->> 'label')) > 20
      OR COALESCE(tier ->> 'color', '') !~ '^#[0-9A-Fa-f]{6}$'
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 30
      OR jsonb_array_length(tier -> 'models') = 0
      OR (tier ->> 'sort_order')::NUMERIC < 0
      OR (tier ->> 'sort_order')::NUMERIC <> trunc((tier ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD tier fields'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE COALESCE(model ->> 'id', '') !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
      OR char_length(model ->> 'id') > 64
      OR COALESCE(model ->> 'openrouter_model_id', '') !~ '^[^[:space:]/]+/[^[:space:]/]+$'
      OR char_length(model ->> 'openrouter_model_id') > 200
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) NOT BETWEEN 1 AND 40
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 15
      OR (model ->> 'price_input')::NUMERIC * 10
         <> trunc((model ->> 'price_input')::NUMERIC * 10)
      OR (model ->> 'price_output')::NUMERIC * 10
         <> trunc((model ->> 'price_output')::NUMERIC * 10)
      OR jsonb_typeof(model -> 'markup') IS DISTINCT FROM 'number'
      OR (model ->> 'markup')::NUMERIC NOT IN (0, 1, 1.5, 2, 2.5, 3, 3.5, 4)
      OR (
        (model ->> 'markup')::NUMERIC = 0
        AND (
          (model ->> 'price_input')::NUMERIC <> 0
          OR (model ->> 'price_output')::NUMERIC <> 0
        )
      )
      OR (model ->> 'sort_order')::NUMERIC < 0
      OR (model ->> 'sort_order')::NUMERIC <> trunc((model ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD model fields'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT model ->> 'openrouter_model_id')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog OpenRouter mappings must be unique'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS admin.list_analytics_users(TEXT, INTEGER, INTEGER);
CREATE FUNCTION admin.list_analytics_users(
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  user_id UUID,
  tg_id TEXT,
  tg_username TEXT,
  display_name TEXT,
  source_id TEXT,
  created_at TIMESTAMPTZ,
  miniapp_entered_at TIMESTAMPTZ,
  st_initialized_at TIMESTAMPTZ,
  total_round BIGINT,
  total_credits NUMERIC,
  total_paid_amount NUMERIC,
  last_active_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.analytics_require_access(true);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'analytics pagination is outside the allowed range'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT u.id, u.tg_id, s.tg_username, COALESCE(s.display_name, s.tg_first_name),
    u.source_id, u.created_at, u.miniapp_entered_at, u.st_initialized_at,
    COALESCE(s.total_round, u.total_round), COALESCE(w.total_credits, 0),
    COALESCE(w.total_paid_amount, 0),
    (SELECT max(h.created_at) FROM miniapp.chat_history h WHERE h.user_id = u.id)
  FROM miniapp.users u
  LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
  LEFT JOIN miniapp.user_wallets w ON w.user_id = u.id
  WHERE p_search IS NULL OR trim(p_search) = ''
     OR u.id::TEXT ILIKE '%' || trim(p_search) || '%'
     OR u.tg_id ILIKE '%' || trim(p_search) || '%'
     OR COALESCE(s.tg_username, '') ILIKE '%' || trim(p_search) || '%'
     OR COALESCE(s.display_name, '') ILIKE '%' || trim(p_search) || '%'
  ORDER BY u.created_at DESC, u.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION admin.list_llm_usage_charges(
  p_from TIMESTAMPTZ DEFAULT (now() - interval '30 days'),
  p_to TIMESTAMPTZ DEFAULT now(),
  p_search TEXT DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
  p_fallback BOOLEAN DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  id UUID,
  charge_key UUID,
  generation_id TEXT,
  user_id UUID,
  tg_id TEXT,
  display_name TEXT,
  model_id TEXT,
  model_openrouter_id TEXT,
  model_display_name TEXT,
  catalog_version INTEGER,
  pricing_config_version INTEGER,
  usage_cost_usd NUMERIC,
  exchange_rate NUMERIC,
  model_markup NUMERIC,
  initial_amount NUMERIC,
  calculated_amount NUMERIC,
  charged_amount NUMERIC,
  fallback_used BOOLEAN,
  status TEXT,
  debit_ledger_id UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.analytics_require_access(true);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000
     OR p_from IS NULL OR p_to IS NULL OR p_from >= p_to
     OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'LLM spending query is outside the allowed range'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    charge.id, charge.charge_key, charge.generation_id, charge.user_id,
    users.tg_id, COALESCE(settings.display_name, settings.tg_username),
    charge.model_id, charge.model_openrouter_id, charge.model_display_name,
    charge.catalog_version, charge.pricing_config_version,
    charge.usage_cost_usd, charge.exchange_rate, charge.model_markup,
    charge.initial_amount, charge.calculated_amount, charge.charged_amount,
    charge.fallback_used, charge.status, charge.debit_ledger_id,
    charge.created_at, charge.updated_at, charge.reconciled_at,
    count(*) OVER ()
  FROM miniapp.llm_usage_charges AS charge
  JOIN miniapp.users AS users ON users.id = charge.user_id
  LEFT JOIN miniapp.miniapp_user_settings AS settings ON settings.user_id = charge.user_id
  WHERE charge.created_at >= p_from
    AND charge.created_at < p_to
    AND (p_model IS NULL OR trim(p_model) = ''
      OR charge.model_id = p_model OR charge.model_openrouter_id = p_model)
    AND (p_fallback IS NULL OR charge.fallback_used = p_fallback)
    AND (p_status IS NULL OR trim(p_status) = '' OR charge.status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = ''
      OR users.tg_id ILIKE '%' || trim(p_search) || '%'
      OR charge.user_id::TEXT ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(settings.display_name, '') ILIKE '%' || trim(p_search) || '%'
      OR charge.model_display_name ILIKE '%' || trim(p_search) || '%'
      OR charge.model_openrouter_id ILIKE '%' || trim(p_search) || '%'
      OR charge.charge_key::TEXT ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(charge.generation_id, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY charge.created_at DESC, charge.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION admin.get_llm_usage_charge_detail(p_charge_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
BEGIN
  PERFORM admin.analytics_require_access(true);
  SELECT to_jsonb(charge) || jsonb_build_object(
    'tg_id', users.tg_id,
    'tg_username', settings.tg_username,
    'display_name', COALESCE(settings.display_name, settings.tg_first_name),
    'ledger_entries', COALESCE((
      SELECT jsonb_agg(to_jsonb(ledger) ORDER BY ledger.created_at)
      FROM miniapp.wallet_ledger AS ledger
      WHERE ledger.reference_type = 'llm_usage'
        AND ledger.reference_id = charge.charge_key::TEXT
    ), '[]'::JSONB)
  ) INTO v_result
  FROM miniapp.llm_usage_charges AS charge
  JOIN miniapp.users AS users ON users.id = charge.user_id
  LEFT JOIN miniapp.miniapp_user_settings AS settings ON settings.user_id = charge.user_id
  WHERE charge.id = p_charge_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'LLM usage charge not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION miniapp.deduct_wallet_credits(UUID, NUMERIC)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION miniapp.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.reconcile_llm_usage(UUID, NUMERIC, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp.deduct_wallet_credits(UUID, NUMERIC)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.reconcile_llm_usage(UUID, NUMERIC, NUMERIC, JSONB)
  TO service_role, postgres;
REVOKE ALL ON FUNCTION admin.list_analytics_users(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.list_llm_usage_charges(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.get_llm_usage_charge_detail(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.list_analytics_users(TEXT, INTEGER, INTEGER)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.list_llm_usage_charges(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER
) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_llm_usage_charge_detail(UUID)
  TO authenticated, service_role, postgres;

COMMENT ON TABLE miniapp.llm_usage_charges IS
  'One immutable-model-snapshot billing record per LLM call; wallet reconciliation updates only monetary outcome fields.';

NOTIFY pgrst, 'reload schema';

COMMIT;
