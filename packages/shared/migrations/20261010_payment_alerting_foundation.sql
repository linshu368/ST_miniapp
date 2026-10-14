-- domain: billing, app_core
--
-- 支付告警的兼容底座：
--   * billing.payment_orders 保留服务端确认的首次/最近收银台交接时间和去重计数；
--   * billing.payment_operation_events 只追加支付操作事实，不改变订单、钱包或履约真相；
--   * app_core.alert_incidents / alert_delivery_attempts 是跨领域的事故和通知意图状态。
--
-- 前置：099 后八域 schema、billing.payment_orders，以及现有受保护的
-- billing.complete_payment_order(text,text,text)。本文件刻意不替换该履约函数。
--
-- 发布：先执行本兼容 migration，再发布 producer / publisher；旧客户端和旧订单无需回填。
-- 回滚：不删除已记录的确认、事件或审计。若对象定义有误，使用审查后的 forward-fix；
--       应用回退前先关闭采集/通知，保留此处新增对象。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_type text;
  v_owner name;
  v_definer boolean;
  v_config text[];
BEGIN
  IF to_regnamespace('billing') IS NULL OR to_regnamespace('app_core') IS NULL THEN
    RAISE EXCEPTION '20261010 payment alerting preflight: billing/app_core schema missing';
  END IF;
  IF to_regclass('billing.payment_orders') IS NULL THEN
    RAISE EXCEPTION '20261010 payment alerting preflight: billing.payment_orders missing';
  END IF;
  IF to_regprocedure('billing.complete_payment_order(text,text,text)') IS NULL THEN
    RAISE EXCEPTION '20261010 payment alerting preflight: protected settlement RPC missing';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(proc.proowner), proc.prosecdef, proc.proconfig
    INTO v_owner, v_definer, v_config
  FROM pg_catalog.pg_proc AS proc
  WHERE proc.oid = 'billing.complete_payment_order(text,text,text)'::regprocedure;
  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_definer IS DISTINCT FROM true
     OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION '20261010 payment alerting preflight: protected settlement RPC has unsafe shape';
  END IF;

  FOREACH v_type IN ARRAY ARRAY[
    'billing.payment_operation_events',
    'app_core.alert_incidents',
    'app_core.alert_delivery_attempts'
  ] LOOP
    IF to_regclass(v_type) IS NOT NULL THEN
      RAISE EXCEPTION '20261010 payment alerting preflight: relation already exists: %', v_type;
    END IF;
  END LOOP;

  -- Existing columns are permitted only when a reviewed force-rerun left the intended shape.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'payment_orders'
      AND column_name = 'checkout_confirmed_at' AND data_type <> 'timestamp with time zone'
  ) OR EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'payment_orders'
      AND column_name = 'last_checkout_confirmed_at' AND data_type <> 'timestamp with time zone'
  ) OR EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'payment_orders'
      AND column_name = 'checkout_confirm_count' AND data_type <> 'integer'
  ) THEN
    RAISE EXCEPTION '20261010 payment alerting preflight: payment_orders confirmation columns have incompatible types';
  END IF;
END
$preflight$;

ALTER TABLE billing.payment_orders
  ADD COLUMN IF NOT EXISTS checkout_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_checkout_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkout_confirm_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT payment_orders_checkout_confirm_count_nonnegative
    CHECK (checkout_confirm_count >= 0);

CREATE INDEX idx_payment_orders_checkout_confirmed_at
  ON billing.payment_orders (checkout_confirmed_at DESC)
  WHERE checkout_confirmed_at IS NOT NULL;

COMMENT ON COLUMN billing.payment_orders.checkout_confirmed_at IS
  '首次由服务端接受的收银台交接原始发生时间；NULL 表示旧客户端或尚未确认，不代表未支付。';
COMMENT ON COLUMN billing.payment_orders.last_checkout_confirmed_at IS
  '最近一次由服务端接受的收银台交接原始发生时间；仅用于支付尝试段与采集质量判断。';
COMMENT ON COLUMN billing.payment_orders.checkout_confirm_count IS
  '服务端接受的去重收银台交接次数；同一 request_id 的重试不增加。';

CREATE TABLE billing.payment_operation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL,
  order_id text,
  user_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN (
    'checkout_confirmation', 'order_creation', 'gateway_create', 'webhook', 'return',
    'payment_query', 'settlement', 'fast_reconcile', 'expiry_reconcile'
  )),
  stage text NOT NULL CHECK (stage IN ('order', 'checkout', 'gateway', 'callback', 'query', 'settlement')),
  outcome text NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'unpaid', 'paid', 'skipped')),
  source text NOT NULL CHECK (source IN ('client', 'backend', 'gateway', 'cron')),
  trigger text NOT NULL CHECK (trigger IN (
    'initial_open', 'reopen', 'webhook', 'return', 'user_poll', 'fast_reconcile',
    'expiry_reconcile', 'create_order', 'settlement'
  )),
  error_class text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT payment_operation_events_event_key_key UNIQUE (event_key),
  CONSTRAINT payment_operation_events_error_class_format
    CHECK (error_class IS NULL OR error_class ~ '^[a-z0-9][a-z0-9:_-]{0,79}$')
);

CREATE INDEX idx_payment_operation_events_occurred_at
  ON billing.payment_operation_events (occurred_at DESC);
CREATE INDEX idx_payment_operation_events_order_recorded_at
  ON billing.payment_operation_events (order_id, recorded_at DESC)
  WHERE order_id IS NOT NULL;

COMMENT ON TABLE billing.payment_operation_events IS
  '支付操作的追加审计事实；旁路采集失败不得改变 payment_orders、钱包或履约。保留期由后续有界清理任务实施。';
COMMENT ON COLUMN billing.payment_operation_events.event_key IS
  '调用方生成的稳定去重键；不得包含 pay_url、签名、密钥、完整 initData、支付账户或原始厂商响应。';
COMMENT ON COLUMN billing.payment_operation_events.metadata IS
  '仅允许低基数、已脱敏的受控字段；不得写入支付链接、签名、密钥、完整 initData、支付账户或原始响应。';

CREATE TABLE app_core.alert_incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-z0-9][a-z0-9:_-]{2,191}$'),
  state text NOT NULL CHECK (state IN ('open', 'recovered')),
  severity text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  confidence text NOT NULL CHECK (confidence IN ('confirmed', 'suspected', 'unknown')),
  location jsonb NOT NULL CHECK (jsonb_typeof(location) = 'object'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  recommended_action text CHECK (recommended_action IS NULL OR char_length(recommended_action) BETWEEN 1 AND 500),
  latest_evaluation_id uuid NOT NULL,
  latest_producer_run_id uuid NOT NULL,
  first_firing_at timestamptz,
  last_firing_at timestamptz,
  last_healthy_at timestamptz,
  last_observed_at timestamptz NOT NULL,
  last_window_ended_at timestamptz NOT NULL,
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(metrics) = 'array'),
  samples jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(samples) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_incidents_fingerprint_key UNIQUE (fingerprint)
);

CREATE INDEX idx_alert_incidents_state_updated_at
  ON app_core.alert_incidents (state, updated_at DESC);

COMMENT ON TABLE app_core.alert_incidents IS
  '跨领域告警事故根状态。Publisher 以稳定 fingerprint 去重，并按窗口结束时间拒绝旧评估回退。';
COMMENT ON COLUMN app_core.alert_incidents.samples IS
  '只存受控、脱敏的告警样本投影；不得保存完整订单号、tg_id、pay_url、签名、密钥、InitData、支付账户、用户内容或原始错误。';

CREATE TABLE app_core.alert_delivery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES app_core.alert_incidents(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('feishu')),
  notification_key text NOT NULL CHECK (notification_key ~ '^[a-z0-9][a-z0-9:_-]{2,191}$'),
  transition text NOT NULL CHECK (transition IN ('firing', 'escalated', 'recovered')),
  state text NOT NULL CHECK (state IN ('pending', 'sending', 'succeeded', 'failed', 'abandoned')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_class text CHECK (last_error_class IS NULL OR last_error_class ~ '^[a-z0-9][a-z0-9:_-]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_delivery_attempts_notification_key_key UNIQUE (notification_key)
);

CREATE INDEX idx_alert_delivery_attempts_due
  ON app_core.alert_delivery_attempts (next_attempt_at, id)
  WHERE state IN ('pending', 'failed') AND next_attempt_at IS NOT NULL;

COMMENT ON TABLE app_core.alert_delivery_attempts IS
  '跨领域告警通知 outbox；同一通知状态迁移以 notification_key 去重，飞书 HTTP 发送永远在数据库事务外。';
COMMENT ON COLUMN app_core.alert_delivery_attempts.payload IS
  '已校验的安全卡片快照；不得写入完整 tg_id、订单号、pay_url、签名、密钥、InitData、支付账户、用户内容或原始错误。';

ALTER TABLE billing.payment_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_core.alert_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_core.alert_delivery_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE billing.payment_operation_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE app_core.alert_incidents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE app_core.alert_delivery_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE billing.payment_operation_events TO postgres, service_role;
GRANT ALL ON TABLE app_core.alert_incidents TO postgres, service_role;
GRANT ALL ON TABLE app_core.alert_delivery_attempts TO postgres, service_role;
REVOKE ALL ON SEQUENCE billing.payment_operation_events_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE app_core.alert_incidents_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE app_core.alert_delivery_attempts_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE billing.payment_operation_events_id_seq TO postgres, service_role;
GRANT USAGE, SELECT ON SEQUENCE app_core.alert_incidents_id_seq TO postgres, service_role;
GRANT USAGE, SELECT ON SEQUENCE app_core.alert_delivery_attempts_id_seq TO postgres, service_role;

CREATE OR REPLACE FUNCTION billing.record_checkout_confirmation(
  p_order_id text,
  p_user_id uuid,
  p_request_id uuid,
  p_occurred_at timestamptz,
  p_action text
) RETURNS TABLE (
  recorded boolean,
  checkout_confirmed_at timestamptz,
  last_checkout_confirmed_at timestamptz,
  checkout_confirm_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_order billing.payment_orders%ROWTYPE;
  v_recorded boolean := false;
  v_event_key text;
BEGIN
  IF p_order_id IS NULL OR p_order_id = '' OR p_user_id IS NULL OR p_request_id IS NULL
     OR p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'checkout confirmation requires order, user, request, and occurred time'
      USING ERRCODE = '22023';
  END IF;
  IF p_action NOT IN ('initial_open', 'reopen') THEN
    RAISE EXCEPTION 'checkout confirmation action is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order
  FROM billing.payment_orders
  WHERE id = p_order_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found'
      USING ERRCODE = 'P0002';
  END IF;

  v_event_key := 'checkout_confirmation:' || p_order_id || ':' || p_request_id::text;
  INSERT INTO billing.payment_operation_events (
    event_key, order_id, user_id, event_kind, stage, outcome, source, trigger, occurred_at
  ) VALUES (
    v_event_key, p_order_id, p_user_id, 'checkout_confirmation', 'checkout', 'succeeded',
    'client', p_action, p_occurred_at
  ) ON CONFLICT (event_key) DO NOTHING;
  v_recorded := FOUND;

  IF v_recorded THEN
    UPDATE billing.payment_orders
    SET
      checkout_confirmed_at = COALESCE(billing.payment_orders.checkout_confirmed_at, p_occurred_at),
      last_checkout_confirmed_at = p_occurred_at,
      checkout_confirm_count = billing.payment_orders.checkout_confirm_count + 1
    WHERE id = p_order_id
    RETURNING * INTO v_order;
  END IF;

  RETURN QUERY
  SELECT v_recorded, v_order.checkout_confirmed_at, v_order.last_checkout_confirmed_at,
    v_order.checkout_confirm_count;
END;
$function$;

ALTER FUNCTION billing.record_checkout_confirmation(text, uuid, uuid, timestamptz, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION billing.record_checkout_confirmation(text, uuid, uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.record_checkout_confirmation(text, uuid, uuid, timestamptz, text)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.record_checkout_confirmation(text, uuid, uuid, timestamptz, text) IS
  '原子记录已鉴权订单的收银台交接。以 order_id/request_id 去重；事件插入成功时才增加确认计数，不修改订单支付或履约状态。';

DO $postflight$
DECLARE
  v_column_count integer;
BEGIN
  SELECT count(*) INTO v_column_count
  FROM information_schema.columns
  WHERE table_schema = 'billing' AND table_name = 'payment_orders'
    AND (column_name, data_type) IN (
      ('checkout_confirmed_at', 'timestamp with time zone'),
      ('last_checkout_confirmed_at', 'timestamp with time zone'),
      ('checkout_confirm_count', 'integer')
    );
  IF v_column_count <> 3 THEN
    RAISE EXCEPTION '20261010 payment alerting postflight: payment order confirmation columns missing';
  END IF;
  IF to_regclass('billing.payment_operation_events') IS NULL
     OR to_regclass('app_core.alert_incidents') IS NULL
     OR to_regclass('app_core.alert_delivery_attempts') IS NULL
     OR to_regprocedure('billing.record_checkout_confirmation(text,uuid,uuid,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION '20261010 payment alerting postflight: required objects missing';
  END IF;
  IF NOT pg_catalog.has_table_privilege('service_role', 'billing.payment_operation_events', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'app_core.alert_incidents', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'app_core.alert_delivery_attempts', 'INSERT')
     OR NOT pg_catalog.has_schema_privilege('service_role', 'billing', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege('service_role', 'app_core', 'USAGE')
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'billing.record_checkout_confirmation(text,uuid,uuid,timestamptz,text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION '20261010 payment alerting postflight: service_role write grant missing';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'billing.payment_operation_events', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'billing.payment_operation_events', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'app_core.alert_incidents', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'app_core.alert_incidents', 'SELECT')
     OR pg_catalog.has_function_privilege(
       'anon', 'billing.record_checkout_confirmation(text,uuid,uuid,timestamptz,text)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'billing.record_checkout_confirmation(text,uuid,uuid,timestamptz,text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION '20261010 payment alerting postflight: API roles received forbidden access';
  END IF;
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';
