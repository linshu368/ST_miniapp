-- Local-only shape so T4 can replace billing.charge_llm_usage.
-- Never apply this file to test or production. Those databases already have the table.

CREATE TABLE IF NOT EXISTS billing.llm_usage_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_key UUID NOT NULL UNIQUE,
  generation_id TEXT,
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
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
    status IN ('pending', 'failed', 'free', 'charged', 'partial', 'reconciled', 'historical')
  ),
  debit_ledger_id UUID REFERENCES billing.wallet_ledger(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_charges_generation_t4
  ON billing.llm_usage_charges (generation_id)
  WHERE generation_id IS NOT NULL;
