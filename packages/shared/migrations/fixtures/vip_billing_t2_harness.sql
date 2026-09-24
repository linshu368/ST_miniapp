-- Local-only prerequisite shape for T2 VIP billing migrations.
-- Never apply this file to test or production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS app_core;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS miniapp_features;

CREATE TABLE IF NOT EXISTS app_core.users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_core.runtime_config (
  key TEXT PRIMARY KEY,
  value JSONB,
  description TEXT,
  version INTEGER DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  text_value TEXT
);

CREATE TABLE IF NOT EXISTS app_core.miniapp_user_settings (
  user_id UUID PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.user_wallets (
  user_id UUID PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  main_credits NUMERIC(14,1) NOT NULL DEFAULT 0 CHECK (main_credits >= 0),
  bonus_credits NUMERIC(14,1) NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_paid_at TIMESTAMPTZ,
  last_paid_at TIMESTAMPTZ,
  total_paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_credits NUMERIC(14,1) GENERATED ALWAYS AS (main_credits + bonus_credits) STORED
);

CREATE TABLE IF NOT EXISTS billing.wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'recharge', 'chat_debit', 'refund', 'adjustment', 'checkin_bonus',
    'wish_reward', 'invite_reward', 'community_reward', 'image_generation'
  )),
  amount NUMERIC(14,1) NOT NULL CHECK (amount <> 0),
  main_delta NUMERIC(14,1) NOT NULL DEFAULT 0,
  bonus_delta NUMERIC(14,1) NOT NULL DEFAULT 0,
  balance_main NUMERIC(14,1) NOT NULL CHECK (balance_main >= 0),
  balance_bonus NUMERIC(14,1) NOT NULL CHECK (balance_bonus >= 0),
  reference_type TEXT,
  reference_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.payment_orders (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired', 'failed')),
  payment_type TEXT NOT NULL CHECK (payment_type IN ('alipay', 'wxpay')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  credits_amount INTEGER NOT NULL CHECK (credits_amount >= 0),
  bonus_credits INTEGER NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  provider_transaction_id TEXT,
  credits_added BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  settled_by TEXT CHECK (settled_by IN ('webhook', 'return', 'query', 'cron'))
);

CREATE TABLE IF NOT EXISTS miniapp_features.daily_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  reward_credits INTEGER NOT NULL CHECK (reward_credits > 0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS miniapp_features.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('official', 'personal')),
  category TEXT NOT NULL CHECK (category IN ('announcement', 'activity', 'system', 'interaction')),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 4000),
  user_id UUID REFERENCES app_core.users(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT notifications_scope_target_check CHECK (
    scope = 'official' OR (scope = 'personal' AND user_id IS NOT NULL)
  )
);

ALTER TABLE billing.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.daily_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_core.miniapp_user_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON miniapp_features.notifications FROM anon, authenticated;
GRANT ALL ON miniapp_features.notifications TO postgres, service_role;

CREATE OR REPLACE FUNCTION billing.grant_bonus_credits(
  p_user_id UUID,
  p_credits NUMERIC,
  p_entry_type TEXT,
  p_reference_type TEXT,
  p_reference_id TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  OUT o_ledger_id UUID,
  OUT o_wallet billing.user_wallets
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  IF p_user_id IS NULL OR p_credits IS NULL OR p_credits <= 0 THEN
    RAISE EXCEPTION 'grant_bonus_credits: credits must be positive' USING ERRCODE = '22023';
  END IF;
  INSERT INTO billing.user_wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  UPDATE billing.user_wallets
  SET bonus_credits = p_credits + billing.user_wallets.bonus_credits, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO o_wallet;
  INSERT INTO billing.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta,
    balance_main, balance_bonus, reference_type, reference_id, metadata
  ) VALUES (
    p_user_id, p_entry_type, p_credits, 0, p_credits,
    o_wallet.main_credits, o_wallet.bonus_credits, p_reference_type, p_reference_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO o_ledger_id;
END;
$$;

REVOKE ALL ON FUNCTION billing.grant_bonus_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.grant_bonus_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION billing.complete_payment_order(
  p_order_id TEXT,
  p_provider_transaction_id TEXT,
  p_settled_by TEXT DEFAULT NULL
) RETURNS billing.payment_orders
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_order billing.payment_orders;
  v_wallet billing.user_wallets;
  v_paid_amount NUMERIC(12, 2);
BEGIN
  SELECT * INTO v_order FROM billing.payment_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found: %', p_order_id USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'completed' AND v_order.credits_added = true THEN
    RETURN v_order;
  END IF;
  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'payment order is not pending: %', p_order_id USING ERRCODE = 'P0001';
  END IF;
  v_paid_amount := (v_order.amount_cents::NUMERIC / 100)::NUMERIC(12, 2);
  UPDATE billing.payment_orders
  SET status = 'completed',
      provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
      credits_added = true,
      settled_by = COALESCE(p_settled_by, settled_by),
      paid_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;
  INSERT INTO billing.user_wallets (
    user_id, main_credits, bonus_credits, first_paid_at, last_paid_at, total_paid_amount, updated_at
  ) VALUES (
    v_order.user_id, v_order.credits_amount, v_order.bonus_credits, now(), now(), v_paid_amount, now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    main_credits = EXCLUDED.main_credits + billing.user_wallets.main_credits,
    bonus_credits = EXCLUDED.bonus_credits + billing.user_wallets.bonus_credits,
    first_paid_at = COALESCE(billing.user_wallets.first_paid_at, EXCLUDED.first_paid_at),
    last_paid_at = EXCLUDED.last_paid_at,
    total_paid_amount = billing.user_wallets.total_paid_amount + EXCLUDED.total_paid_amount,
    updated_at = now()
  RETURNING * INTO v_wallet;
  INSERT INTO billing.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
    reference_type, reference_id, metadata
  ) VALUES (
    v_order.user_id, 'recharge', v_order.credits_amount + v_order.bonus_credits,
    v_order.credits_amount, v_order.bonus_credits, v_wallet.main_credits, v_wallet.bonus_credits,
    'payment_order', v_order.id,
    jsonb_build_object('provider_transaction_id', p_provider_transaction_id, 'paid_amount', v_paid_amount, 'settled_by', v_order.settled_by)
  );
  RETURN v_order;
END;
$$;

GRANT EXECUTE ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT) TO service_role, postgres;

CREATE OR REPLACE FUNCTION miniapp_features.claim_daily_checkin(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_last_claimed_at TIMESTAMPTZ;
  v_reward INTEGER;
  v_ledger_id UUID;
  v_grant RECORD;
  v_claimed_at TIMESTAMPTZ := now();
BEGIN
  SELECT claimed_at INTO v_last_claimed_at
  FROM miniapp_features.daily_checkins
  WHERE user_id = p_user_id
  ORDER BY claimed_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND AND v_last_claimed_at > v_claimed_at - interval '24 hours' THEN
    RAISE EXCEPTION 'daily check-in is not ready: %', p_user_id USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(floor(COALESCE(
    (SELECT NULLIF(value #>> '{}', '')::numeric FROM app_core.runtime_config WHERE key = 'miniapp_daily_checkin_bonus_credits'),
    10
  ))::integer, 10) INTO v_reward;
  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id, v_reward, 'checkin_bonus', 'daily_checkin', p_user_id::text,
    jsonb_build_object('claimed_at', v_claimed_at)
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;
  INSERT INTO miniapp_features.daily_checkins (user_id, reward_credits, claimed_at)
  VALUES (p_user_id, v_reward, v_claimed_at);
  RETURN jsonb_build_object(
    'wallet', to_jsonb(v_wallet),
    'checkin', jsonb_build_object(
      'claimed_at', v_claimed_at,
      'next_claim_at', v_claimed_at + interval '24 hours',
      'reward_credits', v_reward,
      'wallet_ledger_id', v_ledger_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp_features.claim_daily_checkin(UUID) TO service_role, postgres, anon, authenticated;

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at)
VALUES ('miniapp_daily_checkin_bonus_credits', '40'::jsonb, 'local harness checkin reward', 1, now())
ON CONFLICT (key) DO UPDATE SET value = '40'::jsonb;
