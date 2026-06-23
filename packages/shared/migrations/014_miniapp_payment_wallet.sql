-- 014: MiniApp 独立支付订单与钱包
--
-- 目标：
--   - MiniApp 支付数据与 Bot 的 public.payment_orders 完全隔离
--   - MiniApp 钱包数据与 public.users / public.bot_users 的积分字段完全隔离
--   - 支付 webhook 到账通过数据库函数完成，保证订单状态与钱包加分在同一事务内提交

CREATE TABLE IF NOT EXISTS miniapp.payment_orders (
  id                      TEXT PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'completed', 'expired', 'failed')),
  payment_type            TEXT NOT NULL CHECK (payment_type IN ('alipay', 'wxpay')),
  amount_cents            INTEGER NOT NULL CHECK (amount_cents > 0),
  credits_amount          INTEGER NOT NULL CHECK (credits_amount >= 0),
  bonus_credits           INTEGER NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  provider_transaction_id TEXT,
  credits_added           BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  paid_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_miniapp_payment_orders_user_created
  ON miniapp.payment_orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_miniapp_payment_orders_status
  ON miniapp.payment_orders(status);

CREATE TABLE IF NOT EXISTS miniapp.user_wallets (
  user_id        UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  main_credits   INTEGER NOT NULL DEFAULT 0 CHECK (main_credits >= 0),
  bonus_credits  INTEGER NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION miniapp.complete_payment_order(
  p_order_id TEXT,
  p_provider_transaction_id TEXT
) RETURNS miniapp.payment_orders
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order miniapp.payment_orders;
BEGIN
  SELECT *
  INTO v_order
  FROM miniapp.payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found: %', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status = 'completed' AND v_order.credits_added = true THEN
    RETURN v_order;
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'payment order is not pending: %', p_order_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE miniapp.payment_orders
  SET
    status = 'completed',
    provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
    credits_added = true,
    paid_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  INSERT INTO miniapp.user_wallets (
    user_id,
    main_credits,
    bonus_credits,
    updated_at
  ) VALUES (
    v_order.user_id,
    v_order.credits_amount,
    v_order.bonus_credits,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    main_credits = miniapp.user_wallets.main_credits + EXCLUDED.main_credits,
    bonus_credits = miniapp.user_wallets.bonus_credits + EXCLUDED.bonus_credits,
    updated_at = now();

  RETURN v_order;
END;
$$;

ALTER TABLE miniapp.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.user_wallets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON miniapp.payment_orders FROM anon, authenticated;
REVOKE ALL ON miniapp.user_wallets FROM anon, authenticated;
GRANT ALL ON miniapp.payment_orders TO service_role, postgres;
GRANT ALL ON miniapp.user_wallets TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.complete_payment_order(TEXT, TEXT) TO service_role, postgres;

COMMENT ON TABLE miniapp.payment_orders IS
  'MiniApp 独立支付订单表。与 Bot 的 public.payment_orders 完全隔离，不参与 ST 同步。';

COMMENT ON TABLE miniapp.user_wallets IS
  'MiniApp 独立钱包表。与 public.users / public.bot_users 的积分字段完全隔离。';

COMMENT ON FUNCTION miniapp.complete_payment_order(TEXT, TEXT) IS
  'MiniApp 支付到账事务函数：pending 订单置 completed，并幂等地给 miniapp.user_wallets 加积分。';
