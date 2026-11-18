-- Domain: admin（运营托管配置的写入校验）——数据库重组阶段 3d。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3d，规则见 docs/db/CONTRACT.md §2.5。
--
-- 把 16 层的 admin.validate_managed_config_value（最外层 + 15 个 *_before_*）压成一层 CASE 分发：
--   前置：20261118_db_reorg_p3d_align_test_validator_chain.sql 已把 TEST 的错位链对齐成生产当前的 16 层；
--   1. 守卫：16 层必须是写本迁移时的版本（按去掉 \r 后的 md5 比：TEST 与生产只差换行符 CRLF/LF；已压平则跳过）；旧最外层改名 *_legacy；
--   2. 建新函数（先查是否托管，再按 key 分发；判断与报错原文照搬当前生效的那一层）与 4 个具名校验函数；
--   3. 自检：合成样例 + config_drafts / config_releases / runtime_config 的全部现存值，逐条比新旧结果
--      （成功，或"错误码:文案"）。托管 key 必须完全一致；非托管/退役 key 新函数必须报 not managed。不一致整体回滚；
--   4. 删旧链 16 个函数和只被退役分支用的 2 个辅助函数；收权；更新注释。
-- 有意的行为差异：退役 key 存草稿改为拒绝（原来只在最底层查托管，上层有分支的退役 key 能存草稿、不能发布）；
--   未登记的 image_advanced_* 报错文案从 "no longer managed" 变为 "not managed by admin"。
--
-- Verify: bash scripts/test-db-reorg-p3d-migration.sh
-- Release: TEST -> Production（无后端改动）。
-- Recovery: 新函数与旧链对现存全部配置值结果一致；如需回退，按历史迁移重建旧链（20261117_drive_mode.sql 等）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. 守卫 + 旧最外层改名 ------------------------------------------------------------------------
DO $flatten$
DECLARE
  v_bad text;
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value_before_drive_mode(text,jsonb,text)') IS NULL THEN
    IF position('单层分发' IN (SELECT prosrc FROM pg_proc
                               WHERE oid = to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)'))) > 0 THEN
      RETURN;  -- 已压平（重跑）
    END IF;
    RAISE EXCEPTION 'admin.validate_managed_config_value is neither the 16-layer chain nor the flattened version';
  END IF;

  SELECT string_agg(t.fn, ', ') INTO v_bad
  FROM (VALUES
    ('validate_managed_config_value', 'c637e78820a51c60ac0b6b8749681997'),  -- 含视频目录分支（20261118_media_plaza_video_production_config.sql）
    ('validate_managed_config_value_before_drive_mode', 'c59a939fb223ce5efa9771fba280c2d2'),
    ('validate_managed_config_value_before_free_zone', 'cb7231a5a388e44c0953573d8a98672d'),
    ('validate_managed_config_value_before_story_memory', '47560512792fcaf2e17a11fe4dadd7d0'),
    ('validate_managed_config_value_before_lobby_rotation', 'e5437d86931ebc68e6083bae2fe8ca0f'),
    ('validate_managed_config_value_before_creator_review', '1b2e7c9a07f543cd38de0f96363517c3'),
    ('validate_managed_config_value_before_checkin_tiers', '54d69e3bb4034cf09893a665b6971cf2'),
    ('validate_managed_config_value_before_reply_styles', 'dfa1bd840e718465e29a0c327d9ef2bf'),
    ('validate_managed_config_value_before_image_plaza_tags_feature', '89ac9b618d02c95f2f8f489ab2b10fef'),
    ('validate_managed_config_value_before_image_plaza', 'ccefb9ee6d1de89e9c05ac52909f1211'),
    ('validate_managed_config_value_before_instruction_slots', 'caca71a531ae7759326c95fd140d7ed3'),
    ('validate_managed_config_value_before_rich_reply_protocol', '2b9d6e649cdea5ebd73988d3c508f0fc'),
    ('validate_managed_config_value_before_vip_strategy', 'b2983e9f975228e058e5bb2c5d0562e7'),
    ('validate_managed_config_value_before_provider_routing', '7271d892ab3423eb39c1d776ddc6e0ad'),
    ('validate_managed_config_value_before_payment_prompt', 'f4a48cba8a5cf986322576f2cf86df7c'),
    ('validate_managed_config_value_before_fixed_billing', 'd2621ae91ba2957375abed820d3751bd')
  ) AS t(fn, md5sum)
  WHERE (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc p WHERE p.oid = to_regprocedure('admin.' || t.fn || '(text,jsonb,text)'))
        IS DISTINCT FROM t.md5sum;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'validator layers differ from the versions this migration was written against: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'admin'::regnamespace
      AND proname LIKE 'validate\_managed\_config\_value%') <> 16 THEN
    RAISE EXCEPTION 'unexpected extra admin.validate_managed_config_value* layers; refusing to flatten';
  END IF;

  ALTER FUNCTION admin.validate_managed_config_value(text, jsonb, text) RENAME TO validate_managed_config_value_legacy;
END
$flatten$;

-- 2. 具名校验函数（长分支，原文搬自生效层）------------------------------------------------------
CREATE OR REPLACE FUNCTION admin.validate_reply_style_options(p_value jsonb, p_text_value text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_option JSONB;
  v_field TEXT;
  v_text TEXT;
  v_length BIGINT;
  v_limit INTEGER;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_markers TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'reply_style_options must use JSON value only' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 1
     OR jsonb_typeof(p_value -> 'options') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'reply_style_options must contain only an options array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_value -> 'options') > 24 THEN
    RAISE EXCEPTION 'reply_style_options allows at most 24 options' USING ERRCODE = '22023';
  END IF;
  FOR v_option IN SELECT jsonb_array_elements(p_value -> 'options') LOOP
    IF jsonb_typeof(v_option) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'reply style option must be an object' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v_option)) <> 6
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_option) AS key
         WHERE key NOT IN ('id', 'name', 'description', 'marker', 'rules', 'enabled'))
       OR jsonb_typeof(v_option -> 'id') IS DISTINCT FROM 'string'
       OR (v_option ->> 'id') !~ '^style-[a-z0-9][a-z0-9-]{0,58}$'
       OR jsonb_typeof(v_option -> 'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'reply style option has invalid fields or identity' USING ERRCODE = '22023';
    END IF;
    IF (v_option ->> 'id') = ANY(v_ids) THEN
      RAISE EXCEPTION 'reply style option identities must be unique' USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_option ->> 'id');
    FOREACH v_field IN ARRAY ARRAY['name', 'description', 'marker', 'rules'] LOOP
      IF jsonb_typeof(v_option -> v_field) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'reply style text fields must be strings' USING ERRCODE = '22023';
      END IF;
      -- Match ECMAScript TrimString, including NBSP and pasted byte-order marks.
      v_text := btrim(v_option ->> v_field, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
      -- Match JavaScript/Zod's UTF-16 length even for supplementary characters.
      SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
        INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
      v_limit := CASE v_field WHEN 'name' THEN 40 WHEN 'description' THEN 200
        WHEN 'marker' THEN 120 ELSE 12000 END;
      IF v_length > v_limit OR (v_field = 'name' AND v_length = 0) THEN
        RAISE EXCEPTION 'reply style text field exceeds its bounds' USING ERRCODE = '22023';
      END IF;
      IF v_field = 'marker' AND v_text <> '' THEN
        IF v_text = ANY(v_markers) THEN
          RAISE EXCEPTION 'nonempty reply style markers must be unique' USING ERRCODE = '22023';
        END IF;
        v_markers := array_append(v_markers, v_text);
      END IF;
    END LOOP;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION admin.validate_pref_word_count_tiers(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_value -> 'tiers') = 0
     OR jsonb_typeof(p_value -> 'default_tier_id') IS DISTINCT FROM 'string'
     OR COALESCE(char_length(trim(p_value ->> 'default_tier_id')), 0) = 0 THEN
    RAISE EXCEPTION
      'pref_word_count_tiers must include nonempty tiers and default_tier_id'
      USING ERRCODE = '22023';
  END IF;

  v_columns := NULLIF(p_value #>> '{layout,columns}', '')::NUMERIC;
  IF v_columns IS NULL OR v_columns NOT IN (2, 3, 4) THEN
    RAISE EXCEPTION 'pref_word_count_tiers.layout.columns must be 2, 3 or 4'
      USING ERRCODE = '22023';
  END IF;

  v_ids := ARRAY[]::TEXT[];
  v_default := trim(p_value ->> 'default_tier_id');
  FOR v_tier IN SELECT value FROM jsonb_array_elements(p_value -> 'tiers')
  LOOP
    IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
       OR COALESCE(char_length(trim(v_tier ->> 'id')), 0) = 0
       OR COALESCE(char_length(trim(v_tier ->> 'ui_label')), 0) = 0
       OR COALESCE(char_length(trim(v_tier ->> 'prompt_value')), 0) = 0
       OR jsonb_typeof(v_tier -> 'enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_tier -> 'sort_order') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'pref_word_count_tiers contains an invalid tier'
        USING ERRCODE = '22023';
    END IF;

    IF trim(v_tier ->> 'id') = ANY (v_ids) THEN
      RAISE EXCEPTION 'pref_word_count_tiers tier ids must be unique'
        USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, trim(v_tier ->> 'id'));

    IF trim(v_tier ->> 'id') = v_default AND (v_tier ->> 'enabled')::BOOLEAN IS TRUE THEN
      v_enabled_default := TRUE;
    END IF;
  END LOOP;

  IF NOT v_enabled_default THEN
    RAISE EXCEPTION 'pref_word_count_tiers.default_tier_id must match an enabled tier'
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- 套餐列表（数组形）。对象形 miniapp_payment_plans 的 plans 子字段也用它校验。
CREATE OR REPLACE FUNCTION admin.validate_payment_plan_list(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_value) = 0 THEN
    RAISE EXCEPTION 'miniapp_payment_plans must be a nonempty JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value) AS plan
    WHERE jsonb_typeof(plan) IS DISTINCT FROM 'object'
      OR COALESCE(char_length(trim(plan ->> 'id')), 0) = 0
      OR jsonb_typeof(plan -> 'price_cents') IS DISTINCT FROM 'number'
      OR jsonb_typeof(plan -> 'credits_amount') IS DISTINCT FROM 'number'
      OR jsonb_typeof(plan -> 'bonus_credits') IS DISTINCT FROM 'number'
      OR CASE
           WHEN jsonb_typeof(plan -> 'price_cents') = 'number'
           THEN (plan ->> 'price_cents')::NUMERIC < 0
           ELSE true
         END
      OR CASE
           WHEN jsonb_typeof(plan -> 'credits_amount') = 'number'
           THEN (plan ->> 'credits_amount')::NUMERIC < 0
           ELSE true
         END
      OR CASE
           WHEN jsonb_typeof(plan -> 'bonus_credits') = 'number'
           THEN (plan ->> 'bonus_credits')::NUMERIC < 0
           ELSE true
         END
      OR COALESCE(plan ->> 'variant', '') NOT IN (
        'entry', 'standard', 'recommended', 'premium'
      )
  ) THEN
    RAISE EXCEPTION 'miniapp_payment_plans contains an invalid plan'
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- miniapp_payment_plans：对象形 {plans, payment_channels}；非对象沿用数组形（数组形不检查 text_value，沿用原行为）。
CREATE OR REPLACE FUNCTION admin.validate_payment_plans_config(p_value jsonb, p_text_value text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_default TEXT;
  v_alipay_enabled BOOLEAN;
  v_wxpay_enabled BOOLEAN;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    PERFORM admin.validate_payment_plan_list(p_value);
    RETURN;
  END IF;

  IF p_text_value IS NOT NULL THEN
    RAISE EXCEPTION 'miniapp_payment_plans must not use text_value' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_value) AS key
    WHERE key NOT IN ('plans', 'payment_channels')
  ) OR (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 2 THEN
    RAISE EXCEPTION 'miniapp_payment_plans only accepts plans and payment_channels'
      USING ERRCODE = '22023';
  END IF;

  PERFORM admin.validate_payment_plan_list(p_value -> 'plans');

  IF jsonb_typeof(p_value -> 'payment_channels') IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_value -> 'payment_channels')) <> 3
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_value -> 'payment_channels') AS key
       WHERE key NOT IN ('alipay_enabled', 'wxpay_enabled', 'default_payment_type')
     ) THEN
    RAISE EXCEPTION 'payment_channels must contain exactly alipay_enabled, wxpay_enabled and default_payment_type'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_value -> 'payment_channels' -> 'alipay_enabled') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_value -> 'payment_channels' -> 'wxpay_enabled') IS DISTINCT FROM 'boolean'
     OR (p_value -> 'payment_channels' ->> 'default_payment_type') NOT IN ('alipay', 'wxpay') THEN
    RAISE EXCEPTION 'payment_channels has invalid field types' USING ERRCODE = '22023';
  END IF;
  v_alipay_enabled := (p_value -> 'payment_channels' ->> 'alipay_enabled')::boolean;
  v_wxpay_enabled := (p_value -> 'payment_channels' ->> 'wxpay_enabled')::boolean;
  v_default := p_value -> 'payment_channels' ->> 'default_payment_type';
  IF NOT v_alipay_enabled AND NOT v_wxpay_enabled THEN
    RAISE EXCEPTION 'at least one payment channel must be enabled' USING ERRCODE = '22023';
  END IF;
  IF (v_default = 'alipay' AND NOT v_alipay_enabled)
     OR (v_default = 'wxpay' AND NOT v_wxpay_enabled) THEN
    RAISE EXCEPTION 'default payment channel must be enabled' USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- 3. 单层分发 -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
-- 单层分发（数据库重组 3d）。加 key：admin.managed_config_keys 插一行 + 下面加一个 WHEN（长校验拆成具名函数）。
-- 字段细则在 shared zod；这里保证落库的形状，报错文案供运营平台显示。
DECLARE
  v_text text;
  v_length bigint;
  v_field text;
  v_rotation jsonb;
  v_value numeric;
  v_lower integer;
  v_upper integer;
BEGIN
  IF admin.is_managed_config_key(p_config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key USING ERRCODE = '22023';
  END IF;

  -- 只收 JSON 值的 key：带 text_value 一律先拒（与原各层第一句一致）。
  IF p_text_value IS NOT NULL AND p_config_key IN (
    'miniapp_checkin_new_user_credits', 'miniapp_checkin_veteran_credits',
    'image_plaza_enabled', 'image_plaza_model_catalog', 'image_plaza_share_tip', 'image_plaza_tags',
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config', 'vip_text_discount_rate',
    'vip_checkin_bonus_config', 'feature_free_trial_limits',
    'llm_provider_routing_config', 'image_text_model_config',
    'miniapp_invite_reward_rules', 'miniapp_invite_center_config',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
    'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
    'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
    'image_failed_unknown_hint',
    'lobby_ranking_params', 'pref_word_count_tiers'
  ) THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;

  CASE p_config_key
    -- 对话：模式、指令、回复风格、记忆 ----------------------------------------------------------
    WHEN 'drive_mode_options' THEN
      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
         OR jsonb_typeof(p_value -> 'modes') IS DISTINCT FROM 'array'
         OR jsonb_typeof(p_value -> 'default_mode_id') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'drive mode options require a JSON object with modes and default_mode_id'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'system_instructions' THEN
      IF p_value IS NOT NULL
         OR p_text_value IS NULL
         OR char_length(btrim(p_text_value)) = 0 THEN
        RAISE EXCEPTION 'system_instructions must store nonempty markdown in text_value only'
          USING ERRCODE = '22023';
      END IF;
      FOREACH v_field IN ARRAY ARRAY[
        '{{CHOICE_RULES}}', '{{STATUS_RULES}}', '{{MEMORY_RULES}}',
        '{{WORD_COUNT}}', '{{USER_CUSTOM_INSTRUCTIONS}}'
      ] LOOP
        IF position(v_field IN p_text_value) = 0 THEN
          RAISE EXCEPTION 'system_instructions is missing required placeholder %', v_field
            USING ERRCODE = '22023';
        END IF;
      END LOOP;

    WHEN 'choice_rules', 'status_rules', 'memory_rules' THEN
      IF p_text_value IS NOT NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 3
         OR EXISTS (
           SELECT 1 FROM jsonb_object_keys(p_value) AS key
           WHERE key NOT IN ('on_first_two_turns', 'on_later_turns', 'off')
         ) THEN
        RAISE EXCEPTION '% must be a three-field JSONB instruction-slot value', p_config_key
          USING ERRCODE = '22023';
      END IF;
      FOREACH v_field IN ARRAY ARRAY['on_first_two_turns', 'on_later_turns', 'off'] LOOP
        IF jsonb_typeof(p_value -> v_field) IS DISTINCT FROM 'string'
           OR char_length(btrim(p_value ->> v_field)) = 0 THEN
          RAISE EXCEPTION '% field % must be a nonempty string', p_config_key, v_field
            USING ERRCODE = '22023';
        END IF;
      END LOOP;

    WHEN 'reply_style_options' THEN
      PERFORM admin.validate_reply_style_options(p_value, p_text_value);

    WHEN 'pref_word_count_tiers' THEN
      PERFORM admin.validate_pref_word_count_tiers(p_value);

    WHEN 'story_memory_config' THEN
      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
        RAISE EXCEPTION 'story memory config requires a JSON object' USING ERRCODE = '22023';
      END IF;

    WHEN 'story_memory_prompt' THEN
      v_text := btrim(p_text_value, U&'\0009\000A\000B\000C\000D\0020\00A0\3000\FEFF');
      SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
        INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
      IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 20000 THEN
        RAISE EXCEPTION 'story memory prompt requires text only, between 1 and 20000 characters'
          USING ERRCODE = '22023';
      END IF;

    -- 模型与计费 ---------------------------------------------------------------------------------
    WHEN 'llm_model_catalog' THEN
      PERFORM admin.validate_model_catalog_core(p_value);
      PERFORM admin.validate_model_catalog_prd(p_value);

    WHEN 'llm_pricing_config' THEN
      PERFORM admin.validate_fixed_llm_deduction_config(p_value);

    WHEN 'llm_provider_routing_config' THEN
      PERFORM admin.validate_llm_provider_routing_config(p_value);

    WHEN 'free_zone_config' THEN
      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
        RAISE EXCEPTION 'free zone config requires a JSON object' USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_character_free_chat_quota_limit' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
         OR (p_value #>> '{}')::NUMERIC < 1 THEN
        RAISE EXCEPTION
          'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_free_quota_exhausted_dialog_config' THEN
      PERFORM admin.validate_free_quota_exhausted_dialog_config(p_value);

    -- 积分、签到、邀请、充值、VIP ---------------------------------------------------------------
    WHEN 'miniapp_new_user_signup_bonus_credits' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC < 0 THEN
        RAISE EXCEPTION '% must be a nonnegative JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_checkin_new_user_credits', 'miniapp_checkin_veteran_credits' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}') !~ '^[0-9]+$'
         OR (p_value #>> '{}')::integer > 1000000 THEN
        RAISE EXCEPTION '% must be a nonnegative integer JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_invite_reward_rules' THEN
      PERFORM admin.validate_invite_reward_rules(p_value);

    WHEN 'miniapp_invite_center_config' THEN
      PERFORM admin.validate_invite_center_config(p_value);

    WHEN 'miniapp_invite_entry_enabled' THEN
      IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a JSON boolean' USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_payment_plans' THEN
      PERFORM admin.validate_payment_plans_config(p_value, p_text_value);

    WHEN 'vip_purchase_enabled', 'vip_reminders_enabled' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION '% must be a JSON boolean', p_config_key USING ERRCODE = '22023';
      END IF;

    WHEN 'vip_plans_config' THEN
      PERFORM admin.validate_vip_plans_config(p_value);

    WHEN 'vip_text_discount_rate' THEN
      PERFORM admin.validate_vip_text_discount_rate(p_value);

    WHEN 'vip_checkin_bonus_config' THEN
      PERFORM admin.validate_vip_checkin_bonus_config(p_value);

    WHEN 'feature_free_trial_limits' THEN
      PERFORM admin.validate_feature_free_trial_limits(p_value);

    -- 大厅与角色卡 -------------------------------------------------------------------------------
    WHEN 'lobby_ranking_params' THEN
      PERFORM admin.validate_lobby_ranking_params(p_value);
      IF p_value ? 'rotation' THEN
        v_rotation := p_value -> 'rotation';
        IF jsonb_typeof(v_rotation) IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_rotation -> 'enabled') IS DISTINCT FROM 'boolean' THEN
          RAISE EXCEPTION 'Invalid lobby rotation configuration' USING ERRCODE = '22023';
        END IF;
        FOR v_field, v_lower, v_upper IN SELECT * FROM (VALUES
          ('interval_hours', 1, 168), ('max_repeat', 0, 12),
          ('exploration_count', 0, 2), ('rollout_percent', 0, 100)
        ) AS bounds(field, lower_bound, upper_bound)
        LOOP
          IF jsonb_typeof(v_rotation -> v_field) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Invalid lobby rotation field %', v_field USING ERRCODE = '22023';
          END IF;
          v_value := (v_rotation ->> v_field)::numeric;
          IF v_value <> trunc(v_value) OR v_value < v_lower OR v_value > v_upper THEN
            RAISE EXCEPTION 'Invalid lobby rotation range %', v_field USING ERRCODE = '22023';
          END IF;
        END LOOP;
      END IF;

    WHEN 'creator_character_review_prompt' THEN
      v_text := btrim(p_text_value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
      SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
        INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
      IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 12000 THEN
        RAISE EXCEPTION 'creator review policy requires text only, between 1 and 12000 characters'
          USING ERRCODE = '22023';
      END IF;

    -- 图片：生成、描述、广场、视频广场 -----------------------------------------------------------
    WHEN 'image_plaza_video_model_catalog' THEN
      IF p_text_value IS NOT NULL THEN
        RAISE EXCEPTION 'video catalog must not use text_value' USING ERRCODE = '22023';
      END IF;
      PERFORM admin.validate_image_plaza_video_model_catalog(p_value);

    WHEN 'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
         'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
         'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
         'image_failed_unknown_hint' THEN
      PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);

    WHEN 'image_text_model_config' THEN
      PERFORM admin.validate_image_text_model_config(p_value);

    WHEN 'image_description_system_prompt' THEN
      IF p_value IS NOT NULL OR p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0
         OR char_length(p_text_value) > 12000 THEN
        RAISE EXCEPTION 'image_description_system_prompt must use a nonempty text_value up to 12000 chars'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'image_plaza_enabled' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN
        RAISE EXCEPTION 'image_plaza_enabled must be boolean' USING ERRCODE = '22023';
      END IF;

    WHEN 'image_plaza_model_catalog', 'image_plaza_share_tip', 'image_plaza_tags' THEN
      IF jsonb_typeof(p_value) NOT IN ('object', 'array') THEN
        RAISE EXCEPTION '% has invalid shape', p_config_key USING ERRCODE = '22023';
      END IF;
      CASE p_config_key
        WHEN 'image_plaza_model_catalog' THEN PERFORM admin.validate_image_plaza_model_catalog(p_value);
        WHEN 'image_plaza_share_tip' THEN PERFORM admin.validate_image_plaza_share_tip(p_value);
        ELSE PERFORM admin.validate_image_plaza_tags(p_value);
      END CASE;

    ELSE
      RAISE EXCEPTION 'managed config validation is missing for key: %', p_config_key
        USING ERRCODE = '22023';
  END CASE;
END;
$function$;

REVOKE ALL ON FUNCTION admin.validate_managed_config_value(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.validate_reply_style_options(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.validate_pref_word_count_tiers(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.validate_payment_plan_list(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.validate_payment_plans_config(jsonb, text) FROM PUBLIC;

-- 4. 自检：新旧结果逐条一致（只在旧链还在时做）-------------------------------------------------
DO $selfcheck$
DECLARE
  r record;
  v_old text;
  v_new text;
  v_expected text;
  v_checked integer := 0;
  v_mismatches integer := 0;
  v_first text;
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value_legacy(text,jsonb,text)') IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE p3d_samples (config_key text, value jsonb, text_value text, source text) ON COMMIT DROP;
  -- 每个登记 key（含退役、非运营托管）+ 未登记 key × 常见类型 × text_value 组合。
  INSERT INTO p3d_samples
  SELECT k.config_key, v.value, t.text_value, 'matrix'
  FROM (SELECT config_key FROM admin.managed_config_keys
        UNION SELECT unnest(ARRAY['__not_registered__', 'image_advanced_width', NULL])) AS k(config_key)
  CROSS JOIN (VALUES (NULL::jsonb), ('null'), ('true'), ('false'), ('0'), ('1'), ('-1'), ('1.5'), ('1000001'),
                     ('"x"'), ('"00000000-0000-4000-8000-000000000001"'), ('[]'), ('[{}]'), ('{}'),
                     ('{"__fail":true}'), ('{"options":[]}'), ('{"modes":[],"default_mode_id":"a"}')) AS v(value)
  CROSS JOIN (VALUES (NULL::text), (''), ('x')) AS t(text_value);
  -- 各分支的合法与边界样例。
  INSERT INTO p3d_samples (config_key, value, text_value, source)
  SELECT s.config_key, s.value::jsonb, s.text_value, 'branch' FROM (VALUES
    ('drive_mode_options', '{"modes":[{"id":"a"}],"default_mode_id":"a"}', NULL),
    ('drive_mode_options', '{"modes":{},"default_mode_id":"a"}', NULL),
    ('drive_mode_options', '{"modes":[],"default_mode_id":1}', NULL),
    ('story_memory_prompt', NULL, 'remember'),
    ('story_memory_prompt', NULL, U&'\3000\FEFF '),
    ('story_memory_prompt', NULL, repeat('记', 20000)),
    ('story_memory_prompt', NULL, repeat('记', 20001)),
    ('story_memory_prompt', '{}', 'remember'),
    ('creator_character_review_prompt', NULL, 'review'),
    ('creator_character_review_prompt', NULL, U&'\2003\2028'),
    ('creator_character_review_prompt', NULL, repeat('审', 12001)),
    ('creator_character_review_prompt', NULL, repeat(U&'\+01F600', 6001)),
    ('miniapp_checkin_new_user_credits', '1000000', NULL),
    ('miniapp_checkin_veteran_credits', '"5"', NULL),
    ('reply_style_options', '{"options":[{"id":"style-a","name":"甲","description":"d","marker":"m","rules":"r","enabled":true}]}', NULL),
    ('reply_style_options', '{"options":[{"id":"style-a","name":"甲","description":"d","marker":"m","rules":"r","enabled":true},{"id":"style-a","name":"乙","description":"d","marker":"n","rules":"r","enabled":true}]}', NULL),
    ('reply_style_options', '{"options":[{"id":"style-a","name":"甲","description":"d","marker":"m","rules":"r","enabled":true},{"id":"style-b","name":"乙","description":"d","marker":" m ","rules":"r","enabled":true}]}', NULL),
    ('reply_style_options', '{"options":[{"id":"style-a","name":"  ","description":"d","marker":"","rules":"r","enabled":true}]}', NULL),
    ('reply_style_options', '{"options":[{"id":"bad","name":"甲","description":"d","marker":"","rules":"r","enabled":true}]}', NULL),
    ('reply_style_options', '{"options":[{"id":"style-a","name":"甲","description":"d","marker":"","rules":"r","enabled":true,"x":1}]}', NULL),
    ('reply_style_options', '{"options":[1]}', NULL),
    ('reply_style_options', '{"options":[],"x":1}', NULL),
    ('image_plaza_enabled', 'true', NULL),
    ('image_plaza_tags', '[]', NULL),
    ('image_plaza_share_tip', '{}', NULL),
    ('image_plaza_model_catalog', '"x"', NULL),
    ('image_plaza_video_model_catalog', '{"models":[]}', NULL),
    ('image_plaza_video_model_catalog', '{"models":[]}', 'x'),
    ('choice_rules', '{"on_first_two_turns":"a","on_later_turns":"b","off":"c"}', NULL),
    ('status_rules', '{"on_first_two_turns":"a","on_later_turns":" ","off":"c"}', NULL),
    ('memory_rules', '{"on_first_two_turns":"a","on_later_turns":"b","other":"c"}', NULL),
    ('memory_rules', '{"on_first_two_turns":"a","on_later_turns":1,"off":"c"}', NULL),
    ('system_instructions', NULL, '{{CHOICE_RULES}}{{STATUS_RULES}}{{MEMORY_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}'),
    ('system_instructions', NULL, '{{CHOICE_RULES}}{{STATUS_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}'),
    ('system_instructions', NULL, '{{WORD_COUNT}}{{INTERACTION_MODE}}{{USER_CUSTOM_INSTRUCTIONS}}'),
    ('system_instructions', '{}', '{{CHOICE_RULES}}'),
    ('miniapp_payment_plans', '[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}]', NULL),
    ('miniapp_payment_plans', '[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}]', 'x'),
    ('miniapp_payment_plans', '[{"id":"p1","price_cents":-1,"credits_amount":10,"bonus_credits":0,"variant":"entry"}]', NULL),
    ('miniapp_payment_plans', '[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"vip"}]', NULL),
    ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":true,"wxpay_enabled":false,"default_payment_type":"alipay"}}', NULL),
    ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":true,"wxpay_enabled":false,"default_payment_type":"wxpay"}}', NULL),
    ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":false,"wxpay_enabled":false,"default_payment_type":"alipay"}}', NULL),
    ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":"yes","wxpay_enabled":false,"default_payment_type":"alipay"}}', NULL),
    ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":true}}', NULL),
    ('miniapp_payment_plans', '{"plans":{"id":"p1"},"payment_channels":{"alipay_enabled":true,"wxpay_enabled":true,"default_payment_type":"alipay"}}', NULL),
    ('miniapp_payment_plans', '{"plans":[],"payment_channels":{},"x":1}', NULL),
    ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":true,"wxpay_enabled":true,"default_payment_type":"alipay"}}', 'x'),
    ('vip_purchase_enabled', 'true', NULL),
    ('miniapp_invite_entry_enabled', 'false', NULL),
    ('image_description_system_prompt', NULL, 'describe'),
    ('image_description_system_prompt', NULL, repeat('图', 12001)),
    ('lobby_ranking_params', '{"rotation":{"enabled":true,"interval_hours":24,"max_repeat":3,"exploration_count":1,"rollout_percent":50}}', NULL),
    ('lobby_ranking_params', '{"rotation":{"enabled":true,"interval_hours":0,"max_repeat":3,"exploration_count":1,"rollout_percent":50}}', NULL),
    ('lobby_ranking_params', '{"rotation":{"enabled":true,"interval_hours":24,"max_repeat":1.5,"exploration_count":1,"rollout_percent":50}}', NULL),
    ('lobby_ranking_params', '{"rotation":{"enabled":true,"interval_hours":24,"max_repeat":3,"exploration_count":1}}', NULL),
    ('lobby_ranking_params', '{"rotation":{"enabled":"yes"}}', NULL),
    ('lobby_ranking_params', '{"rotation":[]}', NULL),
    ('pref_word_count_tiers', '{"tiers":[{"id":"a","ui_label":"短","prompt_value":"100","enabled":true,"sort_order":1}],"default_tier_id":"a","layout":{"columns":3}}', NULL),
    ('pref_word_count_tiers', '{"tiers":[{"id":"a","ui_label":"短","prompt_value":"100","enabled":true,"sort_order":1}],"default_tier_id":"a","layout":{"columns":5}}', NULL),
    ('pref_word_count_tiers', '{"tiers":[{"id":"a","ui_label":"短","prompt_value":"100","enabled":false,"sort_order":1}],"default_tier_id":"a","layout":{"columns":2}}', NULL),
    ('pref_word_count_tiers', '{"tiers":[{"id":"a","ui_label":"短","prompt_value":"100","enabled":true,"sort_order":1},{"id":" a ","ui_label":"长","prompt_value":"9","enabled":true,"sort_order":2}],"default_tier_id":"a","layout":{"columns":4}}', NULL),
    ('pref_word_count_tiers', '{"tiers":[{"id":"a"}],"default_tier_id":"a","layout":{"columns":3}}', NULL),
    ('pref_word_count_tiers', '{"tiers":[],"default_tier_id":"a"}', NULL),
    ('miniapp_character_free_chat_quota_limit', '3', NULL),
    ('miniapp_character_free_chat_quota_limit', '0', 'x'),
    ('miniapp_new_user_signup_bonus_credits', '2.5', 'x'),
    ('miniapp_new_user_signup_bonus_credits', '"1"', NULL),
    ('lobby_pinned_characters', '{"fixed_character_id":"00000000-0000-4000-8000-000000000001"}', NULL),
    ('system_fallback_character_id', '"00000000-0000-4000-8000-000000000001"', NULL),
    ('media_feature_free_trial_limit', '5', NULL)
  ) AS s(config_key, value, text_value);
  -- 现存全部配置值（只在库内比对，不输出值本身）。
  INSERT INTO p3d_samples
  SELECT d.config_key, d.value, d.text_value, 'config_drafts' FROM admin.config_drafts d
  UNION ALL SELECT rl.config_key, rl.value, rl.text_value, 'config_releases' FROM admin.config_releases rl
  UNION ALL SELECT rc.key, rc.value, rc.text_value, 'runtime_config' FROM app_core.runtime_config rc;

  FOR r IN SELECT * FROM p3d_samples LOOP
    BEGIN
      PERFORM admin.validate_managed_config_value_legacy(r.config_key, r.value, r.text_value);
      v_old := 'ok';
    EXCEPTION WHEN OTHERS THEN
      v_old := SQLSTATE || ':' || SQLERRM;
    END;
    BEGIN
      PERFORM admin.validate_managed_config_value(r.config_key, r.value, r.text_value);
      v_new := 'ok';
    EXCEPTION WHEN OTHERS THEN
      v_new := SQLSTATE || ':' || SQLERRM;
    END;
    v_expected := CASE WHEN admin.is_managed_config_key(r.config_key) IS TRUE THEN v_old
                       ELSE '22023:config key is not managed by admin: ' || coalesce(r.config_key, '<NULL>') END;
    v_checked := v_checked + 1;
    IF v_new IS DISTINCT FROM v_expected THEN
      v_mismatches := v_mismatches + 1;
      IF v_first IS NULL THEN
        v_first := format('key=%s source=%s old=%s new=%s', r.config_key, r.source, left(v_old, 200), left(v_new, 200));
      END IF;
    END IF;
  END LOOP;
  IF v_mismatches > 0 THEN
    RAISE EXCEPTION 'flattened validator differs from the 16-layer chain on % of % samples; first: %',
      v_mismatches, v_checked, v_first;
  END IF;
  RAISE NOTICE 'flattened validator matches the 16-layer chain on % samples', v_checked;
END
$selfcheck$;

-- 5. 删旧链与只被退役分支用的辅助函数 -------------------------------------------------------------
DO $drop_chain$
DECLARE
  v_ref text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ '(validate_managed_config_value_(before_|legacy)|validate_lobby_pinned_characters|validate_payment_prompt_dialog_config)'
    AND NOT (n.nspname = 'admin' AND (p.proname LIKE 'validate\_managed\_config\_value\_%'
             OR p.proname IN ('validate_lobby_pinned_characters', 'validate_payment_prompt_dialog_config')));
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'functions outside the chain still call its layers or retired helpers: %', v_ref;
  END IF;
END
$drop_chain$;
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_legacy(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_drive_mode(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_free_zone(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_story_memory(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_lobby_rotation(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_creator_review(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_checkin_tiers(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_reply_styles(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_image_plaza_tags_feature(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_image_plaza(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_instruction_slots(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_rich_reply_protocol(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_vip_strategy(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_provider_routing(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_payment_prompt(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_managed_config_value_before_fixed_billing(text, jsonb, text);
DROP FUNCTION IF EXISTS admin.validate_lobby_pinned_characters(jsonb);
DROP FUNCTION IF EXISTS admin.validate_payment_prompt_dialog_config(jsonb);

COMMENT ON FUNCTION admin.validate_managed_config_value(text, jsonb, text) IS
  '运营托管配置写入前校验（存草稿、发布、回滚都调）。单层按 key 分发：先查 admin.is_managed_config_key（退役/未登记拒绝），再走该 key 的分支。加 key = 登记表插一行 + 这里加一个 WHEN；不改名套函数。';
COMMENT ON TABLE admin.managed_config_keys IS
  '运营平台可写入 config_drafts/config_releases 的 key 登记。加 key = 插一行（并在 admin.validate_managed_config_value 的分发里加一个 WHEN、admin-client 注册）；不再改名套函数、不再重建 CHECK。retired_at 非空表示退役：不可再编辑（草稿也存不进），历史发布仍引用。';

NOTIFY pgrst, 'reload schema';
COMMIT;
