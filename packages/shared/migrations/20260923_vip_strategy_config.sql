-- 20260923_vip_strategy_config.sql
-- domain: app_core + admin + billing + miniapp_features
--
-- T3A forward-fix。不修改已应用的 20260921_* 与 20260922_daily_checkin_vip_bonus.sql。
--
-- 纳管：
--   vip_purchase_enabled / vip_reminders_enabled（已有，保持 false）
--   vip_plans_config / vip_text_discount_rate / vip_checkin_bonus_config / feature_free_trial_limits
-- 首次 seed 等价于当前行为：购买和提醒关闭；周卡 1399 分 / 7 天 / 0 赠送；
-- 月卡 2888 分 / 31 天 / 3000 专项星尘；折扣 0.95；签到 same_as_base；免费次数各 3。
--
-- 对象归属：
--   已发布配置仍是 app_core.runtime_config。草稿、发布和校验函数仍是 admin。
--   免费序号约束与预留函数仍是 billing。签到发放函数仍是 miniapp_features。
--   不新建表。权威写入方仍是 Admin 发布 RPC；运行时只读已发布 value。
--
-- 签名兼容：
--   billing.complete_payment_order(text, text, text default null)
--   billing.reserve_feature_free_trial(uuid, text, text, integer)
--   miniapp_features.claim_daily_checkin(uuid)
-- 调用方分别是支付履约 repository、后续媒体预留和签到 repository。本文件不改参数。
-- 履约改为相信订单行上的金额/天数/赠送快照，不再要求写死的 1399/2888。
-- 签到和免费预留在各自事务内读取已发布配置；缺失或损坏时签到回到 same_as_base，
-- 免费上限回到 3。购买/提醒开关的 fail closed 在 Backend，不在本函数里打开。
--
-- 范围与 Shared/Admin 一致：
--   价格 1..1000000 分；天数 1..3660；赠送和固定签到 0..1000000；周卡赠送必须为 0；
--   折扣 (0, 1]；免费次数 0..20。ordinal CHECK 从 1..3 放宽到 1..20。
--
-- 锁：替换 CHECK 会锁 payment_orders、vip_purchase_grants、feature_free_trials、
-- config_drafts、config_releases，并重验已有行。不改写业务行。lock_timeout 5s。
-- 恢复：已售会员、订单、流水、签到和免费事实不回改。若要回到旧价格，发布 seed 值；
-- 不要 down migration。已存在非默认快照后，不能再把精确 1399/2888 CHECK 加回去。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('admin.config_drafts') IS NULL
     OR to_regclass('admin.config_releases') IS NULL
     OR to_regclass('billing.feature_free_trials') IS NULL
     OR to_regclass('billing.payment_orders') IS NULL
     OR to_regclass('billing.vip_purchase_grants') IS NULL THEN
    RAISE EXCEPTION '20260923_vip_strategy_config: required tables missing';
  END IF;
  IF to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '20260923_vip_strategy_config: managed config functions missing';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_vip_strategy(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION '20260923_vip_strategy_config: already applied';
  END IF;
  IF to_regprocedure('billing.reserve_feature_free_trial(uuid,text,text,integer)') IS NULL
     OR to_regprocedure('billing.complete_payment_order(text,text,text)') IS NULL
     OR to_regprocedure('miniapp_features.claim_daily_checkin(uuid)') IS NULL THEN
    RAISE EXCEPTION '20260923_vip_strategy_config: VIP runtime functions missing';
  END IF;
END;
$$;

-- ── 1. seed。已有开关不改值；新 key 冲突时保留已发布值，postflight 再核对 seed。 ──
UPDATE app_core.runtime_config
SET description = 'VIP 商品下单开关。由运营台 VIP策略发布。缺失或不是 JSON 布尔时后端关闭购买。'
WHERE key = 'vip_purchase_enabled';

UPDATE app_core.runtime_config
SET description = 'VIP 到期提醒写入开关。由运营台 VIP策略发布。缺失或不是 JSON 布尔时保持关闭。'
WHERE key = 'vip_reminders_enabled';

INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
VALUES
  (
    'vip_plans_config',
    $vip_plans${
      "week": {
        "price_cents": 1399,
        "duration_days": 7,
        "bonus_credits": 0,
        "title": "周卡",
        "description": "7 天 VIP",
        "badge_text": null
      },
      "month": {
        "price_cents": 2888,
        "duration_days": 31,
        "bonus_credits": 3000,
        "title": "月卡",
        "description": "31 天 VIP，赠送 3000 专项星尘",
        "badge_text": null
      }
    }$vip_plans$::jsonb,
    '周卡/月卡价格（分）、有效天数、展示文案和月卡专项星尘。周卡赠送固定为 0。下单时写入订单快照。',
    1,
    now(),
    NULL
  ),
  (
    'vip_text_discount_rate',
    '0.95'::jsonb,
    '有效 VIP 的三档文本折扣率，范围 (0, 1]。生成受理时固化到当次快照。',
    1,
    now(),
    NULL
  ),
  (
    'vip_checkin_bonus_config',
    '{"mode":"same_as_base"}'::jsonb,
    '有效 VIP 的签到加成。same_as_base 与当次基础奖励相同；fixed 使用非负整数 fixed_credits。',
    1,
    now(),
    NULL
  ),
  (
    'feature_free_trial_limits',
    '{"voice":3,"basic_image":3}'::jsonb,
    '语音与初级图片各自的免费成功次数，整数 0..20。0 表示关闭该功能的免费体验。',
    1,
    now(),
    NULL
  )
ON CONFLICT (key) DO NOTHING;

-- ── 2. 草稿/发布 key 白名单 ───────────────────────────────────────────────
DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
  v_key TEXT;
  v_keys CONSTANT TEXT[] := ARRAY[
    'vip_purchase_enabled',
    'vip_reminders_enabled',
    'vip_plans_config',
    'vip_text_discount_rate',
    'vip_checkin_bonus_config',
    'feature_free_trial_limits'
  ];
BEGIN
  FOREACH v_key IN ARRAY v_keys LOOP
    FOREACH v_table IN ARRAY ARRAY[
      'admin.config_drafts'::REGCLASS,
      'admin.config_releases'::REGCLASS
    ] LOOP
      v_constraint_name := CASE v_table
        WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
        ELSE 'config_releases_config_key_check'
      END;

      SELECT pg_get_expr(c.conbin, c.conrelid)
        INTO v_existing_expression
      FROM pg_constraint c
      WHERE c.conrelid = v_table
        AND c.conname = v_constraint_name
        AND c.contype = 'c';

      IF v_existing_expression IS NULL THEN
        RAISE EXCEPTION 'missing expected constraint %.%', v_table, v_constraint_name;
      END IF;
      IF position(v_key IN v_existing_expression) > 0 THEN
        CONTINUE;
      END IF;

      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = %L)',
        v_table,
        v_constraint_name,
        v_existing_expression,
        v_key
      );
    END LOOP;
  END LOOP;
END;
$$;

-- 取 Admin 当前目录与 20260917/20260920 两个版本的并集，避免后写的函数丢掉已纳管 key。
CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits', 'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit', 'miniapp_payment_plans',
    'miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config', 'llm_model_catalog', 'llm_pricing_config',
    'llm_provider_routing_config',
    'system_fallback_character_id', 'system_instructions', 'pref_word_count_tiers',
    'lobby_ranking_params', 'lobby_pinned_characters', 'miniapp_invite_reward_rules',
    'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_text_model_config', 'image_prompt_policy', 'image_default_art_style',
    'image_description_system_prompt', 'image_width', 'image_height',
    'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint',
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config',
    'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits'
  );
$$;

CREATE OR REPLACE FUNCTION admin.assert_vip_json_int(
  p_value JSONB,
  p_min INTEGER,
  p_max INTEGER,
  p_label TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_text TEXT;
  v_int INTEGER;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION '% must be a JSON number', p_label USING ERRCODE = '22023';
  END IF;
  v_text := p_value #>> '{}';
  IF v_text !~ '^-?[0-9]+$' OR char_length(v_text) > 10 THEN
    RAISE EXCEPTION '% must be an integer', p_label USING ERRCODE = '22023';
  END IF;
  v_int := v_text::integer;
  IF v_int < p_min OR v_int > p_max THEN
    RAISE EXCEPTION '% must be between % and %', p_label, p_min, p_max USING ERRCODE = '22023';
  END IF;
  RETURN v_int;
END;
$$;

CREATE OR REPLACE FUNCTION admin.assert_vip_json_text(
  p_value JSONB,
  p_min INTEGER,
  p_max INTEGER,
  p_allow_null BOOLEAN,
  p_label TEXT
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_text TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    IF p_allow_null THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION '% is required', p_label USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION '% must be a string', p_label USING ERRCODE = '22023';
  END IF;
  v_text := btrim(p_value #>> '{}');
  IF char_length(v_text) < p_min OR char_length(v_text) > p_max THEN
    RAISE EXCEPTION '% length is out of range', p_label USING ERRCODE = '22023';
  END IF;
  RETURN v_text;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_vip_plan_terms(p_plan JSONB, p_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_keys TEXT[];
  v_bonus INTEGER;
BEGIN
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'vip plan % must be an object', p_id USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_plan) AS key;
  IF v_keys IS DISTINCT FROM ARRAY['badge_text','bonus_credits','description','duration_days','price_cents','title'] THEN
    RAISE EXCEPTION 'vip plan % has unexpected fields', p_id USING ERRCODE = '22023';
  END IF;
  PERFORM admin.assert_vip_json_int(p_plan->'price_cents', 1, 1000000, p_id || '.price_cents');
  PERFORM admin.assert_vip_json_int(p_plan->'duration_days', 1, 3660, p_id || '.duration_days');
  v_bonus := admin.assert_vip_json_int(p_plan->'bonus_credits', 0, 1000000, p_id || '.bonus_credits');
  IF p_id = 'week' AND v_bonus <> 0 THEN
    RAISE EXCEPTION 'week bonus credits must stay 0' USING ERRCODE = '22023';
  END IF;
  PERFORM admin.assert_vip_json_text(p_plan->'title', 1, 40, false, p_id || '.title');
  PERFORM admin.assert_vip_json_text(p_plan->'description', 0, 200, true, p_id || '.description');
  PERFORM admin.assert_vip_json_text(p_plan->'badge_text', 1, 40, true, p_id || '.badge_text');
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_vip_plans_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_keys TEXT[];
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'vip_plans_config must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_value) AS key;
  IF v_keys IS DISTINCT FROM ARRAY['month','week'] THEN
    RAISE EXCEPTION 'vip_plans_config must contain only week and month' USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_vip_plan_terms(p_value->'week', 'week');
  PERFORM admin.validate_vip_plan_terms(p_value->'month', 'month');
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_vip_text_discount_rate(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_text TEXT;
  v_rate NUMERIC;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'vip_text_discount_rate must be a JSON number' USING ERRCODE = '22023';
  END IF;
  v_text := p_value #>> '{}';
  IF v_text !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'vip_text_discount_rate must be a finite decimal' USING ERRCODE = '22023';
  END IF;
  v_rate := v_text::numeric;
  IF v_rate <= 0 OR v_rate > 1 THEN
    RAISE EXCEPTION 'vip_text_discount_rate must be within (0, 1]' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_vip_checkin_bonus_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_keys TEXT[];
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'vip_checkin_bonus_config must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_value) AS key;
  IF v_keys = ARRAY['mode'] AND p_value->>'mode' = 'same_as_base' THEN
    RETURN;
  END IF;
  IF v_keys = ARRAY['fixed_credits','mode'] AND p_value->>'mode' = 'fixed' THEN
    PERFORM admin.assert_vip_json_int(p_value->'fixed_credits', 0, 1000000, 'fixed_credits');
    RETURN;
  END IF;
  RAISE EXCEPTION 'vip_checkin_bonus_config mode is invalid' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_feature_free_trial_limits(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_keys TEXT[];
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'feature_free_trial_limits must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_value) AS key;
  IF v_keys IS DISTINCT FROM ARRAY['basic_image','voice'] THEN
    RAISE EXCEPTION 'feature_free_trial_limits must contain voice and basic_image' USING ERRCODE = '22023';
  END IF;
  PERFORM admin.assert_vip_json_int(p_value->'voice', 0, 20, 'voice');
  PERFORM admin.assert_vip_json_int(p_value->'basic_image', 0, 20, 'basic_image');
END;
$$;

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_vip_strategy;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key IN (
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config',
    'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits'
  ) AND p_text_value IS NOT NULL THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;

  IF p_config_key IN ('vip_purchase_enabled', 'vip_reminders_enabled') THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION '% must be a JSON boolean', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'vip_plans_config' THEN
    PERFORM admin.validate_vip_plans_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'vip_text_discount_rate' THEN
    PERFORM admin.validate_vip_text_discount_rate(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'vip_checkin_bonus_config' THEN
    PERFORM admin.validate_vip_checkin_bonus_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'feature_free_trial_limits' THEN
    PERFORM admin.validate_feature_free_trial_limits(p_value);
    RETURN;
  END IF;

  -- 20260920 与 20260917 的入口曾经互相覆盖。这里把两边都保住，再委托上一版。
  IF p_config_key = 'image_description_system_prompt' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_description_system_prompt must store text in text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'image_description_system_prompt text_value must be nonempty'
        USING ERRCODE = '22023';
    END IF;
    IF char_length(p_text_value) > 12000 THEN
      RAISE EXCEPTION 'image_description_system_prompt is too long' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'llm_provider_routing_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'llm_provider_routing_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    IF to_regprocedure('admin.validate_llm_provider_routing_config(jsonb)') IS NULL THEN
      RAISE EXCEPTION 'llm_provider_routing_config validator missing' USING ERRCODE = '55000';
    END IF;
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_vip_strategy(p_config_key, p_value, p_text_value);
END;
$$;

REVOKE ALL ON FUNCTION admin.assert_vip_json_int(JSONB, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.assert_vip_json_text(JSONB, INTEGER, INTEGER, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_plan_terms(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_plans_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_text_discount_rate(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_checkin_bonus_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_feature_free_trial_limits(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_vip_strategy(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. 商品快照与免费序号约束 ─────────────────────────────────────────────
DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'billing.vip_purchase_grants'::regclass
      AND contype = 'c'
      AND (
        conname = 'vip_purchase_grants_terms_check'
        OR (
          pg_get_constraintdef(oid) ILIKE '%duration_days%'
          AND pg_get_constraintdef(oid) LIKE '%7%'
          AND pg_get_constraintdef(oid) LIKE '%31%'
        )
      )
  LOOP
    EXECUTE format('ALTER TABLE billing.vip_purchase_grants DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;

ALTER TABLE billing.vip_purchase_grants
  ADD CONSTRAINT vip_purchase_grants_duration_days_check
  CHECK (duration_days BETWEEN 1 AND 3660);

ALTER TABLE billing.vip_purchase_grants
  ADD CONSTRAINT vip_purchase_grants_terms_check
  CHECK (
    amount_cents BETWEEN 1 AND 1000000
    AND bonus_credits BETWEEN 0 AND 1000000
    AND (
      (plan_id = 'week' AND bonus_credits = 0)
      OR plan_id = 'month'
    )
  );

ALTER TABLE billing.payment_orders
  DROP CONSTRAINT payment_orders_product_snapshot_check;

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
      AND amount_cents BETWEEN 1 AND 1000000
      AND vip_duration_days BETWEEN 1 AND 3660
      AND (
        (product_id = 'week' AND COALESCE(vip_bonus_credits, 0) = 0)
        OR (
          product_id = 'month'
          AND vip_bonus_credits BETWEEN 0 AND 1000000
        )
      )
    )
  );

DO $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'billing.feature_free_trials'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%ordinal%'
    AND pg_get_constraintdef(oid) LIKE '%1%'
    AND pg_get_constraintdef(oid) LIKE '%3%'
    AND conname <> 'feature_free_trials_status_shape_check';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'feature_free_trials ordinal check missing';
  END IF;
  EXECUTE format('ALTER TABLE billing.feature_free_trials DROP CONSTRAINT %I', v_name);
END;
$$;

ALTER TABLE billing.feature_free_trials
  ADD CONSTRAINT feature_free_trials_ordinal_check
  CHECK (ordinal BETWEEN 1 AND 20);

COMMENT ON TABLE billing.feature_free_trials IS
  '语音与初级图片免费预留/消费事实。ordinal 为 1..20；当次上限读 feature_free_trial_limits。released 不占 used。';

-- ── 4. 履约仍是 complete_payment_order，但只校验订单快照范围 ─────────────
CREATE OR REPLACE FUNCTION billing.complete_payment_order(
  p_order_id TEXT,
  p_provider_transaction_id TEXT,
  p_settled_by TEXT DEFAULT NULL
) RETURNS billing.payment_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_order billing.payment_orders;
  v_wallet billing.user_wallets;
  v_paid_amount NUMERIC(12, 2);
  v_now TIMESTAMPTZ := now();
  v_product_type TEXT;
  v_plan_id TEXT;
  v_duration INTEGER;
  v_bonus INTEGER;
  v_inserted INTEGER;
  v_membership billing.vip_memberships;
  v_previous_until TIMESTAMPTZ;
  v_new_from TIMESTAMPTZ;
  v_new_until TIMESTAMPTZ;
  v_base TIMESTAMPTZ;
  v_grant billing.vip_purchase_grants;
BEGIN
  SELECT *
  INTO v_order
  FROM billing.payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment order not found: %', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  v_product_type := COALESCE(v_order.product_type, 'credits');

  IF v_order.status = 'completed'
     AND (
       v_order.fulfillment_applied
       OR (v_product_type = 'credits' AND v_order.credits_added)
     ) THEN
    RETURN v_order;
  END IF;

  IF EXISTS (
    SELECT 1 FROM billing.vip_purchase_grants WHERE order_id = p_order_id
  ) THEN
    SELECT * INTO v_order FROM billing.payment_orders WHERE id = p_order_id;
    RETURN v_order;
  END IF;

  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'payment order is not pending: %', p_order_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_settled_by IS NOT NULL AND p_settled_by NOT IN ('webhook', 'return', 'query', 'cron') THEN
    RAISE EXCEPTION 'payment order settled_by is invalid: %', p_order_id
      USING ERRCODE = '22023';
  END IF;

  v_paid_amount := (v_order.amount_cents::NUMERIC / 100)::NUMERIC(12, 2);

  IF v_product_type = 'credits' THEN
    UPDATE billing.payment_orders
    SET
      status = 'completed',
      provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
      credits_added = true,
      fulfillment_applied = true,
      settled_by = COALESCE(p_settled_by, settled_by),
      paid_at = v_now
    WHERE id = p_order_id
    RETURNING * INTO v_order;

    INSERT INTO billing.user_wallets (
      user_id,
      main_credits,
      bonus_credits,
      first_paid_at,
      last_paid_at,
      total_paid_amount,
      updated_at
    ) VALUES (
      v_order.user_id,
      v_order.credits_amount,
      v_order.bonus_credits,
      v_now,
      v_now,
      v_paid_amount,
      v_now
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
      user_id,
      entry_type,
      amount,
      main_delta,
      bonus_delta,
      balance_main,
      balance_bonus,
      reference_type,
      reference_id,
      metadata
    ) VALUES (
      v_order.user_id,
      'recharge',
      v_order.credits_amount + v_order.bonus_credits,
      v_order.credits_amount,
      v_order.bonus_credits,
      v_wallet.main_credits,
      v_wallet.bonus_credits,
      'payment_order',
      v_order.id,
      jsonb_build_object(
        'provider_transaction_id', p_provider_transaction_id,
        'paid_amount', v_paid_amount,
        'settled_by', v_order.settled_by,
        'product_type', 'credits'
      )
    );

    RETURN v_order;
  END IF;

  IF v_product_type <> 'vip' THEN
    RAISE EXCEPTION 'unsupported payment product_type: %', v_product_type
      USING ERRCODE = '22023';
  END IF;

  v_plan_id := v_order.product_id;
  v_duration := v_order.vip_duration_days;
  v_bonus := COALESCE(v_order.vip_bonus_credits, 0);

  -- 不读 vip_plans_config。创建订单时写入的列就是之后履约使用的快照。
  IF v_plan_id NOT IN ('week', 'month')
     OR v_order.credits_amount <> 0
     OR v_order.bonus_credits <> 0
     OR v_duration IS NULL
     OR v_duration < 1
     OR v_duration > 3660
     OR v_order.amount_cents < 1
     OR v_order.amount_cents > 1000000
     OR v_bonus < 0
     OR v_bonus > 1000000
     OR (v_plan_id = 'week' AND v_bonus <> 0) THEN
    RAISE EXCEPTION 'vip payment snapshot is invalid: %', p_order_id
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing.vip_memberships (
    user_id,
    valid_from,
    valid_until,
    last_plan_id,
    version,
    created_at,
    updated_at
  ) VALUES (
    v_order.user_id,
    v_now,
    v_now + make_interval(days => v_duration),
    v_plan_id,
    1,
    v_now,
    v_now
  )
  ON CONFLICT (user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = v_order.user_id
  FOR UPDATE;

  IF v_inserted = 0 THEN
    v_previous_until := v_membership.valid_until;
    v_base := GREATEST(v_now, v_membership.valid_until);
    v_new_from := CASE
      WHEN v_membership.valid_until > v_now THEN v_membership.valid_from
      ELSE v_now
    END;
    v_new_until := v_base + make_interval(days => v_duration);

    UPDATE billing.vip_memberships
    SET
      valid_from = v_new_from,
      valid_until = v_new_until,
      last_plan_id = v_plan_id,
      version = billing.vip_memberships.version + 1,
      updated_at = v_now
    WHERE user_id = v_order.user_id
    RETURNING * INTO v_membership;
  ELSE
    v_previous_until := NULL;
    v_new_from := v_membership.valid_from;
    v_new_until := v_membership.valid_until;
  END IF;

  INSERT INTO billing.vip_purchase_grants (
    order_id,
    user_id,
    plan_id,
    amount_cents,
    duration_days,
    bonus_credits,
    previous_valid_until,
    new_valid_from,
    new_valid_until,
    granted_at
  ) VALUES (
    v_order.id,
    v_order.user_id,
    v_plan_id,
    v_order.amount_cents,
    v_duration,
    v_bonus,
    v_previous_until,
    v_new_from,
    v_new_until,
    v_now
  )
  RETURNING * INTO v_grant;

  INSERT INTO billing.user_wallets (
    user_id,
    first_paid_at,
    last_paid_at,
    total_paid_amount,
    updated_at
  ) VALUES (
    v_order.user_id,
    v_now,
    v_now,
    v_paid_amount,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    first_paid_at = COALESCE(billing.user_wallets.first_paid_at, EXCLUDED.first_paid_at),
    last_paid_at = EXCLUDED.last_paid_at,
    total_paid_amount = billing.user_wallets.total_paid_amount + EXCLUDED.total_paid_amount,
    updated_at = now();

  IF v_bonus > 0 THEN
    PERFORM billing.grant_bonus_credits(
      v_order.user_id,
      v_bonus,
      'vip_bonus',
      'payment_order',
      v_order.id,
      jsonb_build_object(
        'plan_id', v_plan_id,
        'order_id', v_order.id,
        'settled_by', COALESCE(p_settled_by, v_order.settled_by)
      )
    );
  END IF;

  UPDATE billing.payment_orders
  SET
    status = 'completed',
    provider_transaction_id = COALESCE(p_provider_transaction_id, provider_transaction_id),
    credits_added = false,
    fulfillment_applied = true,
    settled_by = COALESCE(p_settled_by, settled_by),
    paid_at = v_now,
    vip_valid_until = v_new_until
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.complete_payment_order(TEXT, TEXT, TEXT) IS
  '支付唯一履约出口。credits 入主/赠送钱包；vip 按订单快照顺延并赠送专项星尘，不读取当前商品配置。仅 service_role。';

-- ── 5. 免费预留在事务内读已发布上限 ───────────────────────────────────────
CREATE OR REPLACE FUNCTION billing.reserve_feature_free_trial(
  p_user_id UUID,
  p_feature TEXT,
  p_reference_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 900
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_reference TEXT;
  v_ttl INTEGER;
  v_existing billing.feature_free_trials;
  v_ordinal INTEGER;
  v_row billing.feature_free_trials;
  v_used INTEGER;
  v_reserved INTEGER;
  v_occupied INTEGER;
  v_limit INTEGER := 3;
  v_limits JSONB;
  v_raw JSONB;
  v_text TEXT;
  v_next INTEGER;
BEGIN
  v_reference := btrim(COALESCE(p_reference_id, ''));
  v_ttl := LEAST(GREATEST(COALESCE(p_ttl_seconds, 900), 30), 3600);

  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') OR v_reference = '' THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(74210022, hashtext(p_user_id::text || ':' || p_feature));
  PERFORM billing.reclaim_expired_feature_free_trials(p_user_id, p_feature);

  SELECT value INTO v_limits
  FROM app_core.runtime_config
  WHERE key = 'feature_free_trial_limits';
  IF v_limits IS NOT NULL AND jsonb_typeof(v_limits) = 'object' THEN
    v_raw := v_limits -> p_feature;
    IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) = 'number' THEN
      v_text := v_raw #>> '{}';
      IF v_text ~ '^(0|[1-9]|1[0-9]|20)$' THEN
        v_limit := v_text::integer;
      END IF;
    END IF;
  END IF;

  SELECT *
  INTO v_existing
  FROM billing.feature_free_trials
  WHERE reference_id = v_reference
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.user_id = p_user_id AND v_existing.feature = p_feature THEN
    IF v_existing.status IN ('reserved', 'consumed') THEN
      SELECT
        count(*) FILTER (WHERE status = 'consumed'),
        count(*) FILTER (WHERE status = 'reserved')
      INTO v_used, v_reserved
      FROM billing.feature_free_trials
      WHERE user_id = p_user_id AND feature = p_feature AND status IN ('reserved', 'consumed');

      SELECT MIN(g.ordinal)
      INTO v_next
      FROM generate_series(1, 20) AS g(ordinal)
      WHERE g.ordinal NOT IN (
        SELECT fft.ordinal
        FROM billing.feature_free_trials AS fft
        WHERE fft.user_id = p_user_id
          AND fft.feature = p_feature
          AND fft.status IN ('reserved', 'consumed')
      );

      RETURN jsonb_build_object(
        'ok', true,
        'status', CASE WHEN v_existing.status = 'consumed' THEN 'already_consumed' ELSE 'already_reserved' END,
        'fact', to_jsonb(v_existing),
        'quota', jsonb_build_object(
          'feature', p_feature,
          'free_trial_limit', v_limit,
          'free_trials_used', v_used,
          'free_trials_reserved', v_reserved,
          'free_trials_remaining', GREATEST(v_limit - v_used - v_reserved, 0),
          'next_trial_ordinal', CASE WHEN v_used + v_reserved < v_limit THEN v_next ELSE NULL END
        )
      );
    END IF;
  ELSIF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
  INTO v_occupied
  FROM billing.feature_free_trials
  WHERE user_id = p_user_id
    AND feature = p_feature
    AND status IN ('reserved', 'consumed');

  IF v_limit = 0 OR v_occupied >= v_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_EXHAUSTED',
      'message', 'free trial occupancy exceeds the account limit'
    );
  END IF;

  SELECT MIN(ordinal)
  INTO v_ordinal
  FROM generate_series(1, 20) AS ordinal
  WHERE ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
  );

  IF v_ordinal IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_EXHAUSTED',
      'message', 'free trial occupancy exceeds the account limit'
    );
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'released' THEN
    UPDATE billing.feature_free_trials
    SET
      ordinal = v_ordinal,
      status = 'reserved',
      reserved_until = now() + make_interval(secs => v_ttl),
      consumed_at = NULL,
      released_at = NULL,
      updated_at = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO billing.feature_free_trials (
      user_id,
      feature,
      reference_id,
      ordinal,
      status,
      reserved_until
    ) VALUES (
      p_user_id,
      p_feature,
      v_reference,
      v_ordinal,
      'reserved',
      now() + make_interval(secs => v_ttl)
    )
    RETURNING * INTO v_row;
  END IF;

  SELECT
    count(*) FILTER (WHERE status = 'consumed'),
    count(*) FILTER (WHERE status = 'reserved')
  INTO v_used, v_reserved
  FROM billing.feature_free_trials
  WHERE user_id = p_user_id AND feature = p_feature AND status IN ('reserved', 'consumed');

  SELECT MIN(g.ordinal)
  INTO v_next
  FROM generate_series(1, 20) AS g(ordinal)
  WHERE g.ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'reserved',
    'fact', to_jsonb(v_row),
    'quota', jsonb_build_object(
      'feature', p_feature,
      'free_trial_limit', v_limit,
      'free_trials_used', v_used,
      'free_trials_reserved', v_reserved,
      'free_trials_remaining', GREATEST(v_limit - v_used - v_reserved, 0),
      'next_trial_ordinal', CASE WHEN v_used + v_reserved < v_limit THEN v_next ELSE NULL END
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER) IS
  '为 voice/basic_image 预留免费名额。上限在事务内读取 feature_free_trial_limits，缺省为 3，0 不分配。仅 service_role。';

-- ── 6. 签到在同一事务读取加成策略 ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION miniapp_features.claim_daily_checkin(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_last_claimed_at TIMESTAMPTZ;
  v_base INTEGER;
  v_vip INTEGER;
  v_total INTEGER;
  v_ledger_id UUID;
  v_grant RECORD;
  v_claimed_at TIMESTAMPTZ := now();
  v_membership billing.vip_memberships;
  v_vip_active BOOLEAN := false;
  v_config JSONB;
  v_config_version INTEGER;
  v_mode TEXT := 'same_as_base';
  v_fixed INTEGER;
  v_fixed_text TEXT;
  v_fallback BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'daily check-in user is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(74210021, hashtext(p_user_id::text));

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_vip_active := FOUND AND v_membership.valid_until > v_claimed_at;

  SELECT claimed_at
  INTO v_last_claimed_at
  FROM miniapp_features.daily_checkins
  WHERE user_id = p_user_id
  ORDER BY claimed_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_last_claimed_at > v_claimed_at - interval '24 hours' THEN
    RAISE EXCEPTION 'daily check-in is not ready: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(
    floor(
      COALESCE(
        (
          SELECT NULLIF(value #>> '{}', '')::numeric
          FROM app_core.runtime_config
          WHERE key = 'miniapp_daily_checkin_bonus_credits'
        ),
        60
      )
    )::integer,
    60
  )
  INTO v_base;

  IF v_base <= 0 THEN
    RAISE EXCEPTION 'daily check-in reward must be positive: %', v_base
      USING ERRCODE = '22023';
  END IF;

  SELECT value, version
  INTO v_config, v_config_version
  FROM app_core.runtime_config
  WHERE key = 'vip_checkin_bonus_config';

  IF v_config IS NULL OR jsonb_typeof(v_config) IS DISTINCT FROM 'object' THEN
    v_fallback := true;
  ELSIF v_config->>'mode' = 'same_as_base' THEN
    v_mode := 'same_as_base';
  ELSIF v_config->>'mode' = 'fixed' THEN
    v_fixed_text := v_config->>'fixed_credits';
    IF v_fixed_text IS NOT NULL
       AND v_fixed_text ~ '^[0-9]+$'
       AND char_length(v_fixed_text) <= 7 THEN
      v_fixed := v_fixed_text::integer;
      IF v_fixed BETWEEN 0 AND 1000000 THEN
        v_mode := 'fixed';
      ELSE
        v_fallback := true;
      END IF;
    ELSE
      v_fallback := true;
    END IF;
  ELSE
    v_fallback := true;
  END IF;

  IF v_fallback THEN
    v_mode := 'same_as_base';
  END IF;

  v_vip := CASE
    WHEN NOT v_vip_active THEN 0
    WHEN v_mode = 'fixed' THEN v_fixed
    ELSE v_base
  END;
  v_total := v_base + v_vip;

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id,
    v_total,
    'checkin_bonus',
    'daily_checkin',
    p_user_id::text,
    jsonb_build_object(
      'claimed_at', v_claimed_at,
      'base_reward_credits', v_base,
      'vip_reward_credits', v_vip,
      'vip_active', v_vip_active,
      'vip_valid_until', CASE WHEN v_vip_active THEN v_membership.valid_until ELSE NULL END,
      'vip_checkin_mode', v_mode,
      'vip_checkin_config_version', v_config_version,
      'vip_checkin_config_fallback', v_fallback
    )
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  INSERT INTO miniapp_features.daily_checkins (
    user_id,
    reward_credits,
    claimed_at
  ) VALUES (
    p_user_id,
    v_total,
    v_claimed_at
  );

  RETURN jsonb_build_object(
    'wallet', to_jsonb(v_wallet),
    'checkin', jsonb_build_object(
      'claimed_at', v_claimed_at,
      'next_claim_at', v_claimed_at + interval '24 hours',
      'reward_credits', v_total,
      'base_reward_credits', v_base,
      'vip_reward_credits', v_vip,
      'vip_active', v_vip_active,
      'wallet_ledger_id', v_ledger_id,
      'vip_checkin_mode', v_mode,
      'vip_checkin_config_version', v_config_version,
      'vip_checkin_config_fallback', v_fallback
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp_features.claim_daily_checkin(UUID)
  TO postgres, service_role, anon, authenticated;

COMMENT ON FUNCTION miniapp_features.claim_daily_checkin(UUID) IS
  '每日签到。用户级锁防首次并发。基础额与 VIP 加成策略在同一事务读取；配置损坏时加成回退为与基础奖励相同。';

-- ── 7. postflight ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cfg TEXT[];
  v_src TEXT;
  v_def TEXT;
  v_raised BOOLEAN;
  v_plans JSONB := $vip_plans${
    "week": {
      "price_cents": 1399,
      "duration_days": 7,
      "bonus_credits": 0,
      "title": "周卡",
      "description": "7 天 VIP",
      "badge_text": null
    },
    "month": {
      "price_cents": 2888,
      "duration_days": 31,
      "bonus_credits": 3000,
      "title": "月卡",
      "description": "31 天 VIP，赠送 3000 专项星尘",
      "badge_text": null
    }
  }$vip_plans$::jsonb;
BEGIN
  IF (SELECT value FROM app_core.runtime_config WHERE key = 'vip_purchase_enabled') IS DISTINCT FROM 'false'::jsonb
     OR (SELECT value FROM app_core.runtime_config WHERE key = 'vip_reminders_enabled') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'postflight: VIP switches must stay false';
  END IF;
  IF (SELECT value FROM app_core.runtime_config WHERE key = 'vip_plans_config') IS DISTINCT FROM v_plans
     OR (SELECT value FROM app_core.runtime_config WHERE key = 'vip_text_discount_rate') IS DISTINCT FROM '0.95'::jsonb
     OR (SELECT value FROM app_core.runtime_config WHERE key = 'vip_checkin_bonus_config') IS DISTINCT FROM '{"mode":"same_as_base"}'::jsonb
     OR (SELECT value FROM app_core.runtime_config WHERE key = 'feature_free_trial_limits') IS DISTINCT FROM '{"voice":3,"basic_image":3}'::jsonb THEN
    RAISE EXCEPTION 'postflight: VIP strategy seed does not match the current defaults';
  END IF;

  IF NOT admin.is_managed_config_key('vip_purchase_enabled')
     OR NOT admin.is_managed_config_key('vip_reminders_enabled')
     OR NOT admin.is_managed_config_key('vip_plans_config')
     OR NOT admin.is_managed_config_key('vip_text_discount_rate')
     OR NOT admin.is_managed_config_key('vip_checkin_bonus_config')
     OR NOT admin.is_managed_config_key('feature_free_trial_limits')
     OR NOT admin.is_managed_config_key('llm_provider_routing_config')
     OR NOT admin.is_managed_config_key('image_description_system_prompt')
     OR NOT admin.is_managed_config_key('llm_model_catalog') THEN
    RAISE EXCEPTION 'postflight: managed key whitelist is incomplete';
  END IF;

  PERFORM admin.validate_managed_config_value('vip_purchase_enabled', 'false'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('vip_plans_config', v_plans, NULL);
  PERFORM admin.validate_managed_config_value('vip_text_discount_rate', '1'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('vip_text_discount_rate', '0.95'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('vip_checkin_bonus_config', '{"mode":"fixed","fixed_credits":0}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('feature_free_trial_limits', '{"voice":0,"basic_image":20}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('feature_free_trial_limits', '{"voice":3,"basic_image":3}'::jsonb, NULL);

  v_raised := false;
  BEGIN
    PERFORM admin.validate_managed_config_value('vip_text_discount_rate', '0'::jsonb, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'postflight: discount 0 was accepted';
  END IF;

  v_raised := false;
  BEGIN
    PERFORM admin.validate_managed_config_value('feature_free_trial_limits', '{"voice":21,"basic_image":3}'::jsonb, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'postflight: free-trial limit 21 was accepted';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'billing.feature_free_trials'::regclass
    AND conname = 'feature_free_trials_ordinal_check';
  IF v_def IS NULL OR position('20' IN v_def) = 0 THEN
    RAISE EXCEPTION 'postflight: ordinal check was not widened to 20';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'billing.payment_orders'::regclass
    AND conname = 'payment_orders_product_snapshot_check';
  IF v_def IS NULL OR position('1399' IN v_def) > 0 THEN
    RAISE EXCEPTION 'postflight: payment snapshot check still pins 1399';
  END IF;

  SELECT proconfig, pg_get_functiondef(oid) INTO v_cfg, v_src
  FROM pg_proc
  WHERE oid = 'billing.reserve_feature_free_trial(uuid,text,text,integer)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg))
     OR position('feature_free_trial_limits' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postflight: reserve_feature_free_trial does not read the published limit';
  END IF;
  IF has_function_privilege('anon', 'billing.reserve_feature_free_trial(uuid,text,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'billing.reserve_feature_free_trial(uuid,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: reserve_feature_free_trial grants changed';
  END IF;

  SELECT proconfig, pg_get_functiondef(oid) INTO v_cfg, v_src
  FROM pg_proc
  WHERE oid = 'miniapp_features.claim_daily_checkin(uuid)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg))
     OR position('vip_checkin_bonus_config' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin does not read the bonus strategy';
  END IF;
  IF NOT has_function_privilege('anon', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin lost its historical execute grants';
  END IF;

  SELECT proconfig, pg_get_functiondef(oid) INTO v_cfg, v_src
  FROM pg_proc
  WHERE oid = 'billing.complete_payment_order(text,text,text)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg))
     OR position('vip_purchase_grants' IN v_src) = 0
     OR position('<> 1399' IN v_src) > 0 THEN
    RAISE EXCEPTION 'postflight: complete_payment_order is not the snapshot-based body';
  END IF;
  IF has_function_privilege('anon', 'billing.complete_payment_order(text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'billing.complete_payment_order(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: complete_payment_order grants changed';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：不 down migration。已创建订单、会员、流水、签到和免费事实保持原样。
-- 停止新价格的办法是再发布一份 seed 配置；它只影响之后创建的订单和之后的领取。
