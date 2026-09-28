-- 20260924_vip_plans_price_1_and_2_yuan.sql
-- domain: app_core (published runtime config), admin (unpublished drafts)
--
-- 产品改价：周卡 1 元、月卡 2 元。不改历史 migration，不重写已创建订单快照。
-- 只改 vip_plans_config 的 price_cents；天数、赠送和文案保持原样。
--
-- 对象：app_core.runtime_config.vip_plans_config；若存在则同步 admin.config_drafts。
-- 权威写入方：本 migration 一次性改已发布值；之后仍由 Admin VIP策略发布。
-- 运行时消费者：Backend readVipStrategy → 支付目录/下单快照；Frontend/Admin 只读该配置。
--
-- 锁：单行 runtime_config 与少量草稿。lock_timeout 5s。
-- 幂等：目标价已是 100/200 时不升 version。可重复执行。
-- 恢复：不要 down migration。若需回退，另发 forward-fix 或从 Admin 发布旧价。
-- 已支付订单继续使用创建时写入的 amount_cents。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('app_core.runtime_config') IS NULL THEN
    RAISE EXCEPTION '20260924_vip_plans_price_1_and_2_yuan: app_core.runtime_config missing';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '20260924_vip_plans_price_1_and_2_yuan: validate_managed_config_value missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_core.runtime_config WHERE key = 'vip_plans_config'
  ) THEN
    RAISE EXCEPTION '20260924_vip_plans_price_1_and_2_yuan: vip_plans_config missing';
  END IF;
END;
$$;

UPDATE app_core.runtime_config
SET
  value = jsonb_set(
    jsonb_set(value, '{week,price_cents}', '100'::jsonb, false),
    '{month,price_cents}',
    '200'::jsonb,
    false
  ),
  version = version + 1,
  updated_at = now()
WHERE key = 'vip_plans_config'
  AND jsonb_typeof(value) = 'object'
  AND jsonb_typeof(value -> 'week') = 'object'
  AND jsonb_typeof(value -> 'month') = 'object'
  AND (
    (value #>> '{week,price_cents}') IS DISTINCT FROM '100'
    OR (value #>> '{month,price_cents}') IS DISTINCT FROM '200'
  );

DO $$
BEGIN
  IF to_regclass('admin.config_drafts') IS NULL THEN
    RETURN;
  END IF;

  UPDATE admin.config_drafts
  SET
    value = jsonb_set(
      jsonb_set(value, '{week,price_cents}', '100'::jsonb, false),
      '{month,price_cents}',
      '200'::jsonb,
      false
    ),
    updated_at = now()
  WHERE config_key = 'vip_plans_config'
    AND jsonb_typeof(value) = 'object'
    AND jsonb_typeof(value -> 'week') = 'object'
    AND jsonb_typeof(value -> 'month') = 'object'
    AND (
      (value #>> '{week,price_cents}') IS DISTINCT FROM '100'
      OR (value #>> '{month,price_cents}') IS DISTINCT FROM '200'
    );
END;
$$;

DO $$
DECLARE
  v_plans JSONB;
BEGIN
  SELECT value INTO v_plans
  FROM app_core.runtime_config
  WHERE key = 'vip_plans_config';

  IF v_plans IS NULL
     OR (v_plans #>> '{week,price_cents}') IS DISTINCT FROM '100'
     OR (v_plans #>> '{month,price_cents}') IS DISTINCT FROM '200' THEN
    RAISE EXCEPTION 'postflight: vip_plans_config prices are not 100/200 -> %', v_plans;
  END IF;

  PERFORM admin.validate_managed_config_value('vip_plans_config', v_plans, NULL);
END;
$$;

COMMIT;

-- 执行后验证：
-- SELECT key, value->'week'->>'price_cents', value->'month'->>'price_cents', version
-- FROM app_core.runtime_config WHERE key = 'vip_plans_config';
