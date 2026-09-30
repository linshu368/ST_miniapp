-- 20260921_vip_billing_schema.sql
-- domain: billing + miniapp_features + app_core
--
-- T2 第 1/4 文件：VIP 公共表、订单/通知/设置兼容列、RLS/grant、约束与索引。
-- 不含业务 RPC（见后续 3 个文件）。不含语音/图片 attempt 列。不改签到奖励数值。
-- 不改写历史 migration。
--
-- 前置（test 已核）：
--   099 八域；billing.payment_orders.settled_by；billing.grant_bonus_credits；
--   app_core.miniapp_user_settings；miniapp_features.notifications。
--   规划 VIP 表当前不存在，可 additive。
-- 执行：GitHub Actions Database Migration，environment=test，一次一个文件。
-- 本文件未 apply 前不得创建 VIP 订单。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.miniapp_user_settings') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL
     OR to_regclass('billing.wallet_ledger') IS NULL
     OR to_regclass('billing.payment_orders') IS NULL
     OR to_regclass('miniapp_features.notifications') IS NULL
     OR to_regclass('miniapp_features.daily_checkins') IS NULL THEN
    RAISE EXCEPTION '20260921_vip_billing_schema: missing 099+ billing/app_core/miniapp_features objects';
  END IF;

  IF to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260921_vip_billing_schema: billing.grant_bonus_credits is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'payment_orders' AND column_name = 'settled_by'
  ) THEN
    RAISE EXCEPTION '20260921_vip_billing_schema: payment_orders.settled_by missing; run 103 first';
  END IF;

  IF to_regclass('billing.vip_memberships') IS NOT NULL
     OR to_regclass('billing.vip_purchase_grants') IS NOT NULL
     OR to_regclass('billing.feature_free_trials') IS NOT NULL
     OR to_regclass('billing.wallet_refunds') IS NOT NULL THEN
    RAISE EXCEPTION '20260921_vip_billing_schema: VIP tables already exist; refuse rerun without force_rerun review';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'payment_orders' AND column_name = 'product_type'
  ) THEN
    RAISE EXCEPTION '20260921_vip_billing_schema: payment_orders.product_type already exists';
  END IF;

  IF to_regclass('app_core.user_settings') IS NOT NULL THEN
    RAISE EXCEPTION '20260921_vip_billing_schema: unexpected app_core.user_settings; use miniapp_user_settings';
  END IF;
END;
$$;

-- ── 1. ledger entry_type 放宽到月卡专项赠送 ────────────────────────────────
ALTER TABLE billing.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;

ALTER TABLE billing.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type = ANY (ARRAY[
    'recharge',
    'chat_debit',
    'refund',
    'adjustment',
    'checkin_bonus',
    'wish_reward',
    'invite_reward',
    'community_reward',
    'image_generation',
    'vip_bonus'
  ]));

ALTER TABLE billing.wallet_ledger
  ADD COLUMN IF NOT EXISTS debit_key TEXT;

COMMENT ON COLUMN billing.wallet_ledger.debit_key IS
  '统一扣款幂等键。历史行 NULL；apply_wallet_debit 写入后不可重复。';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_debit_key
  ON billing.wallet_ledger (debit_key)
  WHERE debit_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_recharge_payment_order
  ON billing.wallet_ledger (reference_id)
  WHERE reference_type = 'payment_order' AND entry_type = 'recharge';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_vip_bonus_order
  ON billing.wallet_ledger (reference_id)
  WHERE entry_type = 'vip_bonus';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_refund_key
  ON billing.wallet_ledger (reference_id)
  WHERE reference_type = 'wallet_refund' AND entry_type = 'refund';

-- ── 2. VIP 会员投影 ────────────────────────────────────────────────────────
CREATE TABLE billing.vip_memberships (
  user_id UUID PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  last_plan_id TEXT NOT NULL CHECK (last_plan_id IN ('week', 'month')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vip_memberships_valid_until_after_from_check CHECK (valid_until > valid_from)
);

CREATE INDEX idx_vip_memberships_valid_until
  ON billing.vip_memberships (valid_until);

COMMENT ON TABLE billing.vip_memberships IS
  '当前 VIP 时长投影。权限只认 valid_until > now()；订单审计在 vip_purchase_grants。';
COMMENT ON COLUMN billing.vip_memberships.last_plan_id IS
  '最近一次成功履约的计划：week | month。';

-- ── 3. 订单履约事实 ────────────────────────────────────────────────────────
CREATE TABLE billing.vip_purchase_grants (
  order_id TEXT PRIMARY KEY REFERENCES billing.payment_orders(id),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('week', 'month')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  duration_days INTEGER NOT NULL CHECK (duration_days IN (7, 31)),
  bonus_credits INTEGER NOT NULL CHECK (bonus_credits >= 0),
  previous_valid_until TIMESTAMPTZ,
  new_valid_from TIMESTAMPTZ NOT NULL,
  new_valid_until TIMESTAMPTZ NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vip_purchase_grants_terms_check CHECK (
    (plan_id = 'week' AND amount_cents = 1399 AND duration_days = 7 AND bonus_credits = 0)
    OR (plan_id = 'month' AND amount_cents = 2888 AND duration_days = 31 AND bonus_credits = 3000)
  ),
  CONSTRAINT vip_purchase_grants_until_after_from_check CHECK (new_valid_until > new_valid_from)
);

CREATE INDEX idx_vip_purchase_grants_user_granted
  ON billing.vip_purchase_grants (user_id, granted_at DESC);

COMMENT ON TABLE billing.vip_purchase_grants IS
  '一个支付订单只履约一次的 VIP 审计事实。重放必须回读此行，不得再顺延。';

-- ── 4. 媒体免费次数公共事实 ───────────────────────────────────────────────
CREATE TABLE billing.feature_free_trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK (feature IN ('voice', 'basic_image')),
  reference_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  reserved_until TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feature_free_trials_status_shape_check CHECK (
    (status = 'reserved' AND reserved_until IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status = 'released' AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_feature_free_trials_reference
  ON billing.feature_free_trials (reference_id);

CREATE UNIQUE INDEX uq_feature_free_trials_occupying_ordinal
  ON billing.feature_free_trials (user_id, feature, ordinal)
  WHERE status IN ('reserved', 'consumed');

CREATE INDEX idx_feature_free_trials_user_feature
  ON billing.feature_free_trials (user_id, feature, created_at DESC);

CREATE INDEX idx_feature_free_trials_reserved_until
  ON billing.feature_free_trials (reserved_until)
  WHERE status = 'reserved';

COMMENT ON TABLE billing.feature_free_trials IS
  '语音与初级图片各自前 3 次成功免费的预留/消费事实。released 不占 used。';

-- ── 5. 原路退款事实 ───────────────────────────────────────────────────────
CREATE TABLE billing.wallet_refunds (
  refund_key TEXT PRIMARY KEY,
  debit_ledger_id UUID NOT NULL UNIQUE REFERENCES billing.wallet_ledger(id),
  refund_ledger_id UUID NOT NULL UNIQUE REFERENCES billing.wallet_ledger(id),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  main_amount NUMERIC(14,1) NOT NULL CHECK (main_amount >= 0),
  bonus_amount NUMERIC(14,1) NOT NULL CHECK (bonus_amount >= 0),
  total_amount NUMERIC(14,1) NOT NULL CHECK (total_amount > 0),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_refunds_split_check CHECK (main_amount + bonus_amount = total_amount)
);

CREATE INDEX idx_wallet_refunds_user_created
  ON billing.wallet_refunds (user_id, created_at DESC);

COMMENT ON TABLE billing.wallet_refunds IS
  '一次负向 debit 最多成功退款一次。refund_key 与 debit_ledger_id 都唯一。';

-- ── 6. payment_orders 商品快照（历史 DEFAULT credits） ────────────────────
ALTER TABLE billing.payment_orders
  ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'credits',
  ADD COLUMN IF NOT EXISTS product_id TEXT,
  ADD COLUMN IF NOT EXISTS vip_duration_days INTEGER,
  ADD COLUMN IF NOT EXISTS vip_bonus_credits INTEGER,
  ADD COLUMN IF NOT EXISTS fulfillment_applied BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vip_valid_until TIMESTAMPTZ;

UPDATE billing.payment_orders
SET fulfillment_applied = credits_added
WHERE fulfillment_applied IS DISTINCT FROM credits_added;

ALTER TABLE billing.payment_orders
  ADD CONSTRAINT payment_orders_product_type_check
  CHECK (product_type IN ('credits', 'vip'));

ALTER TABLE billing.payment_orders
  ADD CONSTRAINT payment_orders_product_snapshot_check
  CHECK (
    (
      product_type = 'credits'
      AND vip_duration_days IS NULL
      AND vip_bonus_credits IS NULL
      AND vip_valid_until IS NULL
    )
    OR (
      product_type = 'vip'
      AND credits_amount = 0
      AND bonus_credits = 0
      AND product_id IN ('week', 'month')
      AND (
        (product_id = 'week' AND amount_cents = 1399 AND vip_duration_days = 7 AND COALESCE(vip_bonus_credits, 0) = 0)
        OR (product_id = 'month' AND amount_cents = 2888 AND vip_duration_days = 31 AND vip_bonus_credits = 3000)
      )
    )
  );

CREATE INDEX idx_payment_orders_product_type
  ON billing.payment_orders (product_type, created_at DESC);

COMMENT ON COLUMN billing.payment_orders.product_type IS
  'credits=星尘充值（历史默认）；vip=周卡/月卡。结算不得重定价。';
COMMENT ON COLUMN billing.payment_orders.fulfillment_applied IS
  '所有商品的履约标志。历史行回填为 credits_added；新代码以本列为准。';

-- ── 7. 通知去重键 ─────────────────────────────────────────────────────────
ALTER TABLE miniapp_features.notifications
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS business_key TEXT,
  ADD COLUMN IF NOT EXISTS action_path TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE miniapp_features.notifications
  ADD CONSTRAINT notifications_kind_check
  CHECK (kind IS NULL OR kind = 'vip_expiry');

ALTER TABLE miniapp_features.notifications
  ADD CONSTRAINT notifications_action_path_check
  CHECK (
    action_path IS NULL
    OR (
      char_length(action_path) BETWEEN 1 AND 200
      AND action_path LIKE '/%'
    )
  );

ALTER TABLE miniapp_features.notifications
  ADD CONSTRAINT notifications_vip_expiry_shape_check
  CHECK (
    (kind IS NULL AND business_key IS NULL AND metadata IS NULL)
    OR (
      kind = 'vip_expiry'
      AND business_key IS NOT NULL
      AND user_id IS NOT NULL
      AND scope = 'official'
      AND metadata IS NOT NULL
      AND jsonb_typeof(metadata) = 'object'
      AND (metadata - 'reminder_window' - 'observed_valid_until') = '{}'::jsonb
      AND metadata->>'reminder_window' IN ('expiring_soon', 'expires_today')
      AND char_length(trim(metadata->>'observed_valid_until')) > 0
    )
  );

CREATE UNIQUE INDEX uq_notifications_business_key
  ON miniapp_features.notifications (business_key)
  WHERE business_key IS NOT NULL;

COMMENT ON COLUMN miniapp_features.notifications.kind IS
  '当前仅 vip_expiry；历史行为 NULL。';
COMMENT ON COLUMN miniapp_features.notifications.business_key IS
  '幂等业务键。VIP 提醒含 user + observed_valid_until + window。';

-- ── 8. 首次 VIP 入口角标 ──────────────────────────────────────────────────
ALTER TABLE app_core.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS vip_entry_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN app_core.miniapp_user_settings.vip_entry_seen_at IS
  '用户首次点击我的页 VIP 入口的时间。非空后角标永久消失，过期/重装不得恢复。';

-- ── 9. 默认关闭的工程开关（不做运营配置 UI） ─────────────────────────────
INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
VALUES
  (
    'vip_purchase_enabled',
    'false'::jsonb,
    'VIP 商品下单开关。默认关闭，避免旧 Backend 在 migration 窗口创建 VIP 订单。',
    1,
    now(),
    NULL
  ),
  (
    'vip_reminders_enabled',
    'false'::jsonb,
    'VIP 到期提醒写入开关。T6 先 dry-run，再打开。',
    1,
    now(),
    NULL
  )
ON CONFLICT (key) DO NOTHING;

-- ── 10. RLS / grants：学 notifications，不给 anon/authenticated 表权限 ────
ALTER TABLE billing.vip_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.vip_purchase_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.feature_free_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.wallet_refunds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE billing.vip_memberships FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE billing.vip_purchase_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE billing.feature_free_trials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE billing.wallet_refunds FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE billing.vip_memberships TO postgres, service_role;
GRANT ALL ON TABLE billing.vip_purchase_grants TO postgres, service_role;
GRANT ALL ON TABLE billing.feature_free_trials TO postgres, service_role;
GRANT ALL ON TABLE billing.wallet_refunds TO postgres, service_role;

-- ── 11. postflight ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_entry_def TEXT;
  v_product_def TEXT;
  v_mismatch INTEGER;
  v_nopolicy INTEGER;
BEGIN
  IF to_regclass('billing.vip_memberships') IS NULL
     OR to_regclass('billing.vip_purchase_grants') IS NULL
     OR to_regclass('billing.feature_free_trials') IS NULL
     OR to_regclass('billing.wallet_refunds') IS NULL THEN
    RAISE EXCEPTION 'postflight: VIP tables missing';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_entry_def
  FROM pg_constraint
  WHERE conrelid = 'billing.wallet_ledger'::regclass
    AND conname = 'wallet_ledger_entry_type_check';
  IF v_entry_def IS NULL OR position('vip_bonus' IN v_entry_def) = 0 THEN
    RAISE EXCEPTION 'postflight: wallet_ledger entry_type check missing vip_bonus -> %', v_entry_def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_product_def
  FROM pg_constraint
  WHERE conrelid = 'billing.payment_orders'::regclass
    AND conname = 'payment_orders_product_snapshot_check';
  IF v_product_def IS NULL OR position('credits' IN v_product_def) = 0 THEN
    RAISE EXCEPTION 'postflight: payment_orders product snapshot check missing';
  END IF;

  SELECT count(*) INTO v_mismatch
  FROM billing.payment_orders
  WHERE fulfillment_applied IS DISTINCT FROM credits_added;
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'postflight: % payment_orders have fulfillment_applied <> credits_added', v_mismatch;
  END IF;

  IF EXISTS (
    SELECT 1 FROM billing.payment_orders WHERE product_type IS DISTINCT FROM 'credits'
  ) THEN
    RAISE EXCEPTION 'postflight: historical payment_orders were not all credits';
  END IF;

  IF has_table_privilege('anon', 'billing.vip_memberships', 'SELECT')
     OR has_table_privilege('authenticated', 'billing.vip_memberships', 'SELECT')
     OR has_table_privilege('anon', 'billing.wallet_refunds', 'SELECT')
     OR has_table_privilege('authenticated', 'billing.feature_free_trials', 'INSERT') THEN
    RAISE EXCEPTION 'postflight: new billing tables must not be granted to anon/authenticated';
  END IF;

  SELECT count(*) INTO v_nopolicy
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'billing'
    AND c.relname IN ('vip_memberships', 'vip_purchase_grants', 'feature_free_trials', 'wallet_refunds')
    AND (NOT c.relrowsecurity OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
  IF v_nopolicy <> 0 THEN
    RAISE EXCEPTION 'postflight: new billing tables must enable RLS with zero policies';
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    RAISE EXCEPTION 'postflight: unexpected pg_cron; VIP reminders must not depend on it';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚 / forward-fix（未出售 VIP、未产生新履约时）：
--   DROP INDEX/TABLE 新对象；DROP 新列前确认无消费者。
--   已产生 VIP 订单后禁止 down migration，改发 forward-fix。
-- 验证：
--   SELECT product_type, count(*) FROM billing.payment_orders GROUP BY 1;
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'vip_memberships';
