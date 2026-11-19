-- Domain: admin（运营托管配置的写入校验）——数据库重组阶段 3d 的 TEST 前置对齐。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3d。
--
-- 背景：20261118_db_reorg_p3d_report_validator_layers.sql 在 TEST 报出校验链与生产不同：早期视频广场迁移
--   （20261027_media_plaza_video_config.sql）在 TEST 按旧办法多套了两层，各层套入顺序也与生产不同
--   （system_instructions 等多层都有的 key，生效的版本可能不同）。生产已按 20261118_media_plaza_video_production_config.sql
--   在最外层原地加了视频分支。
-- 本文件：校验链已与生产一致（生产）或已压平 → 空操作；只在 TEST 上把整条链重建成生产当前的 16 层
--   （函数体由生成脚本从历史迁移原文按生产 md5 抽出，最外层 = 20261117_drive_mode.sql 版本 + 视频分支），
--   建完逐层核对去掉 \r 后的 md5。非 TEST 环境链不一致直接拒绝，不在生产重建。
-- 之后 20261118_db_reorg_p3d_flatten_config_validator.sql 在两个环境面对同一条链，自检照常比对。
--
-- Verify: bash scripts/test-db-reorg-p3d-migration.sh（TEST 形态重建、生产形态空操作、生产拒绝重建）。
-- Release: TEST -> Production（生产为空操作，只为两边账本一致）。
-- Recovery: TEST 原有的错位链不保留（3d 本就会把整条链换成单层）；需要时按历史迁移重放。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $align$
DECLARE
  r record;
  v_bad text;
  v_count integer;
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value_before_drive_mode(text,jsonb,text)') IS NULL
     AND position('单层分发' IN coalesce((SELECT prosrc FROM pg_proc
       WHERE oid = to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)')), '')) > 0 THEN
    RETURN;  -- 已压平
  END IF;

  CREATE TEMP TABLE p3d_layers (ord integer, fn text, md5_no_cr text, body text) ON COMMIT DROP;
  INSERT INTO p3d_layers VALUES
    (1, 'validate_managed_config_value', 'c637e78820a51c60ac0b6b8749681997', $l01$
    BEGIN
  IF p_config_key = 'image_plaza_video_model_catalog' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'video catalog must not use text_value' USING ERRCODE='22023';
    END IF;
    PERFORM admin.validate_image_plaza_video_model_catalog(p_value);
    RETURN;
  END IF;

      -- 字段规则在 shared zod；库里只保证存的是带 modes 数组的 JSON 对象。
      IF p_config_key = 'drive_mode_options' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
           OR jsonb_typeof(p_value -> 'modes') IS DISTINCT FROM 'array'
           OR jsonb_typeof(p_value -> 'default_mode_id') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'drive mode options require a JSON object with modes and default_mode_id'
            USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_drive_mode(p_config_key, p_value, p_text_value);
    END $l01$),
    (2, 'validate_managed_config_value_before_drive_mode', 'c59a939fb223ce5efa9771fba280c2d2', $l02$
    BEGIN
      -- 字段规则在 shared zod 里；库里只保证存的是 JSON 对象，防止畸形发布落库。
      IF p_config_key = 'free_zone_config' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
          RAISE EXCEPTION 'free zone config requires a JSON object' USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_free_zone(p_config_key, p_value, p_text_value);
    END $l02$),
    (3, 'validate_managed_config_value_before_free_zone', 'cb7231a5a388e44c0953573d8a98672d', $l03$
    DECLARE v_text text; v_length bigint;
    BEGIN
      -- Detailed field rules live in the shared zod schema; the database only
      -- guarantees the storage shape so a malformed release cannot be stored.
      IF p_config_key = 'story_memory_config' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
          RAISE EXCEPTION 'story memory config requires a JSON object' USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      IF p_config_key = 'story_memory_prompt' THEN
        v_text := btrim(p_text_value, U&'\0009\000A\000B\000C\000D\0020\00A0\3000\FEFF');
        SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
          INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
        IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 20000 THEN
          RAISE EXCEPTION 'story memory prompt requires text only, between 1 and 20000 characters'
            USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_story_memory(p_config_key, p_value, p_text_value);
    END $l03$),
    (4, 'validate_managed_config_value_before_story_memory', '47560512792fcaf2e17a11fe4dadd7d0', $l04$
DECLARE
  v_rotation jsonb;
  v_field text;
  v_value numeric;
  v_lower integer;
  v_upper integer;
BEGIN
  PERFORM admin.validate_managed_config_value_before_lobby_rotation(p_config_key, p_value, p_text_value);
  IF p_config_key = 'lobby_ranking_params' AND p_value ? 'rotation' THEN
    v_rotation := p_value->'rotation';
    IF jsonb_typeof(v_rotation) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_rotation->'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid lobby rotation configuration' USING ERRCODE = '22023';
    END IF;
    FOR v_field, v_lower, v_upper IN SELECT * FROM (VALUES
      ('interval_hours', 1, 168), ('max_repeat', 0, 12),
      ('exploration_count', 0, 2), ('rollout_percent', 0, 100)
    ) AS bounds(field, lower_bound, upper_bound)
    LOOP
      IF jsonb_typeof(v_rotation->v_field) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Invalid lobby rotation field %', v_field USING ERRCODE = '22023';
      END IF;
      v_value := (v_rotation->>v_field)::numeric;
      IF v_value <> trunc(v_value) OR v_value < v_lower OR v_value > v_upper THEN
        RAISE EXCEPTION 'Invalid lobby rotation range %', v_field USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;
  IF p_config_key = 'lobby_pinned_characters' AND p_value ? 'fixed_character_id'
    AND jsonb_typeof(p_value->'fixed_character_id') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(p_value->'fixed_character_id') IS DISTINCT FROM 'string'
      OR (p_value->>'fixed_character_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid fixed character ID' USING ERRCODE = '22023';
    END IF;
  END IF;
END;
$l04$),
    (5, 'validate_managed_config_value_before_lobby_rotation', 'e5437d86931ebc68e6083bae2fe8ca0f', $l05$
   DECLARE v_text text; v_length bigint;
   BEGIN
     IF p_config_key='creator_character_review_prompt' THEN
       v_text:=btrim(p_text_value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
       SELECT coalesce(sum(CASE WHEN ascii(glyph)>65535 THEN 2 ELSE 1 END),0)
         INTO v_length FROM regexp_split_to_table(v_text,'') AS glyph WHERE glyph<>'';
       IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length=0 OR v_length>12000 THEN
         RAISE EXCEPTION 'creator review policy requires text only, between 1 and 12000 characters' USING ERRCODE='22023';
       END IF;
       RETURN;
     END IF;
     PERFORM admin.validate_managed_config_value_before_creator_review(p_config_key,p_value,p_text_value);
   END $l05$),
    (6, 'validate_managed_config_value_before_creator_review', '1b2e7c9a07f543cd38de0f96363517c3', $l06$
BEGIN
  IF p_config_key IN (
    'miniapp_checkin_new_user_credits',
    'miniapp_checkin_veteran_credits'
  ) THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}') !~ '^[0-9]+$'
       OR (p_value #>> '{}')::integer > 1000000 THEN
      RAISE EXCEPTION '% must be a nonnegative integer JSON number', p_config_key
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_checkin_tiers(
    p_config_key, p_value, p_text_value
  );
END;
$l06$),
    (7, 'validate_managed_config_value_before_checkin_tiers', '54d69e3bb4034cf09893a665b6971cf2', $l07$
      DECLARE
        v_option JSONB;
        v_field TEXT;
        v_text TEXT;
        v_length BIGINT;
        v_limit INTEGER;
        v_ids TEXT[] := ARRAY[]::TEXT[];
        v_markers TEXT[] := ARRAY[]::TEXT[];
      BEGIN
        IF p_config_key = 'reply_style_options' THEN
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
          RETURN;
        END IF;
        PERFORM admin.validate_managed_config_value_before_reply_styles(
          p_config_key, p_value, p_text_value
        );
      END;
      $l07$),
    (8, 'validate_managed_config_value_before_reply_styles', 'dfa1bd840e718465e29a0c327d9ef2bf', $l08$
BEGIN
  IF p_config_key = 'image_plaza_tags_feature_enabled' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'image_plaza_tags_feature_enabled must be boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_image_plaza_tags_feature(
    p_config_key, p_value, p_text_value
  );
END;
$l08$),
    (9, 'validate_managed_config_value_before_image_plaza_tags_feature', '89ac9b618d02c95f2f8f489ab2b10fef', $l09$
BEGIN
  IF p_config_key IN ('image_plaza_enabled', 'image_plaza_model_catalog',
      'image_plaza_share_tip', 'image_plaza_tags') THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_plaza_enabled' AND jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'image_plaza_enabled must be boolean' USING ERRCODE = '22023';
    END IF;
    IF p_config_key <> 'image_plaza_enabled' AND jsonb_typeof(p_value) NOT IN ('object', 'array') THEN
      RAISE EXCEPTION '% has invalid shape', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_plaza_model_catalog' THEN
      PERFORM admin.validate_image_plaza_model_catalog(p_value);
    ELSIF p_config_key = 'image_plaza_share_tip' THEN
      PERFORM admin.validate_image_plaza_share_tip(p_value);
    ELSIF p_config_key = 'image_plaza_tags' THEN
      PERFORM admin.validate_image_plaza_tags(p_value);
    END IF;
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_image_plaza(p_config_key, p_value, p_text_value);
END;
$l09$),
    (10, 'validate_managed_config_value_before_image_plaza', 'ccefb9ee6d1de89e9c05ac52909f1211', $l10$
DECLARE
  v_required_placeholder TEXT;
BEGIN
  IF p_config_key IN ('choice_rules', 'status_rules', 'memory_rules') THEN
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
    FOREACH v_required_placeholder IN ARRAY ARRAY['on_first_two_turns', 'on_later_turns', 'off'] LOOP
      IF jsonb_typeof(p_value -> v_required_placeholder) IS DISTINCT FROM 'string'
         OR char_length(btrim(p_value ->> v_required_placeholder)) = 0 THEN
        RAISE EXCEPTION '% field % must be a nonempty string', p_config_key, v_required_placeholder
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    RETURN;
  END IF;

  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL
       OR p_text_value IS NULL
       OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions must store nonempty markdown in text_value only'
        USING ERRCODE = '22023';
    END IF;
    FOREACH v_required_placeholder IN ARRAY ARRAY[
      '{{CHOICE_RULES}}', '{{STATUS_RULES}}', '{{MEMORY_RULES}}',
      '{{WORD_COUNT}}', '{{USER_CUSTOM_INSTRUCTIONS}}'
    ] LOOP
      IF position(v_required_placeholder IN p_text_value) = 0 THEN
        RAISE EXCEPTION 'system_instructions is missing required placeholder %', v_required_placeholder
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_instruction_slots(
    p_config_key, p_value, p_text_value
  );
END;
$l10$),
    (11, 'validate_managed_config_value_before_instruction_slots', 'caca71a531ae7759326c95fd140d7ed3', $l11$
BEGIN
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_rich_reply_protocol(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$l11$),
    (12, 'validate_managed_config_value_before_rich_reply_protocol', '2b9d6e649cdea5ebd73988d3c508f0fc', $l12$
DECLARE
  v_default TEXT;
  v_alipay_enabled BOOLEAN;
  v_wxpay_enabled BOOLEAN;
BEGIN
  IF p_config_key = 'miniapp_payment_plans' AND jsonb_typeof(p_value) = 'object' THEN
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

    -- Keep the established DB validator as the source of truth for every plan field.
    PERFORM admin.validate_managed_config_value_before_vip_strategy(
      'miniapp_payment_plans',
      p_value -> 'plans',
      NULL
    );

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
    RETURN;
  END IF;

  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)' USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string' USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION 'system_instructions must contain required placeholders' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key LIKE 'image_advanced_%' THEN
    RAISE EXCEPTION 'advanced image configuration is no longer managed' USING ERRCODE = '22023';
  END IF;
  IF p_config_key IN ('vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config', 'vip_text_discount_rate', 'vip_checkin_bonus_config', 'feature_free_trial_limits', 'media_feature_free_trial_limit')
     AND p_text_value IS NOT NULL THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;
  IF p_config_key IN ('vip_purchase_enabled', 'vip_reminders_enabled') THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION '% must be a JSON boolean', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'vip_plans_config' THEN PERFORM admin.validate_vip_plans_config(p_value); RETURN; END IF;
  IF p_config_key = 'vip_text_discount_rate' THEN PERFORM admin.validate_vip_text_discount_rate(p_value); RETURN; END IF;
  IF p_config_key = 'vip_checkin_bonus_config' THEN PERFORM admin.validate_vip_checkin_bonus_config(p_value); RETURN; END IF;
  IF p_config_key = 'feature_free_trial_limits' THEN PERFORM admin.validate_feature_free_trial_limits(p_value); RETURN; END IF;
  IF p_config_key = 'media_feature_free_trial_limit' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR (p_value #>> '{}') !~ '^[0-9]+$' OR (p_value #>> '{}')::integer NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'media_feature_free_trial_limit must be an integer between 1 and 100' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'image_description_system_prompt' THEN
    IF p_value IS NOT NULL OR p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 OR char_length(p_text_value) > 12000 THEN
      RAISE EXCEPTION 'image_description_system_prompt must use a nonempty text_value up to 12000 chars' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key = 'llm_provider_routing_config' THEN
    IF p_text_value IS NOT NULL THEN RAISE EXCEPTION 'llm_provider_routing_config must not use text_value' USING ERRCODE = '22023'; END IF;
    IF to_regprocedure('admin.validate_llm_provider_routing_config(jsonb)') IS NULL THEN RAISE EXCEPTION 'llm_provider_routing_config validator missing' USING ERRCODE = '55000'; END IF;
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_vip_strategy(p_config_key, p_value, p_text_value);
END;
$l12$),
    (13, 'validate_managed_config_value_before_vip_strategy', 'b2983e9f975228e058e5bb2c5d0562e7', $l13$
BEGIN
  IF p_config_key = 'llm_provider_routing_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'llm_provider_routing_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_llm_provider_routing_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_provider_routing(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$l13$),
    (14, 'validate_managed_config_value_before_provider_routing', '7271d892ab3423eb39c1d776ddc6e0ad', $l14$
BEGIN
  IF p_config_key = 'image_text_model_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_text_model_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_text_model_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_reward_rules must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_center_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_center_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a JSON boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key IN (
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_default_art_style', 'image_width', 'image_height', 'image_max_prompt_chars',
    'image_max_output_bytes', 'image_prompt_policy', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint'
  ) THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key, p_value, p_text_value
  );
END;
$l14$),
    (15, 'validate_managed_config_value_before_payment_prompt', 'f4a48cba8a5cf986322576f2cf86df7c', $l15$
DECLARE
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}}, {{INTERACTION_MODE}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'lobby_ranking_params' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_ranking_params must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_ranking_params(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'pref_word_count_tiers' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'pref_word_count_tiers must not use text_value'
        USING ERRCODE = '22023';
    END IF;
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
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_character_free_chat_quota_limit' THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION
        'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
        USING ERRCODE = '22023';
    END IF;
    PERFORM p_text_value;
    RETURN;
  END IF;

  IF p_config_key = 'llm_model_catalog' THEN
    PERFORM admin.validate_model_catalog_core(p_value);
    PERFORM admin.validate_model_catalog_prd(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'llm_pricing_config' THEN
    PERFORM admin.validate_fixed_llm_deduction_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_fixed_billing(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$l15$),
    (16, 'validate_managed_config_value_before_fixed_billing', 'd2621ae91ba2957375abed820d3751bd', $l16$
DECLARE
  v_uuid UUID;
BEGIN
  IF admin.is_managed_config_key(p_config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key
      USING ERRCODE = '22023';
  END IF;

  CASE
    WHEN p_config_key IN (
      'miniapp_new_user_signup_bonus_credits',
      'miniapp_daily_checkin_bonus_credits'
    ) THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC < 0 THEN
        RAISE EXCEPTION '% must be a nonnegative JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'miniapp_payment_plans' THEN
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

    WHEN p_config_key = 'miniapp_recharge_page_config' THEN
      PERFORM admin.validate_recharge_page_config(p_value);

    WHEN p_config_key = 'miniapp_free_quota_exhausted_dialog_config' THEN
      PERFORM admin.validate_free_quota_exhausted_dialog_config(p_value);

    WHEN p_config_key = 'llm_model_catalog' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_value -> 'tiers') = 0
         OR jsonb_typeof(p_value -> 'default_model_id') IS DISTINCT FROM 'string'
         OR COALESCE(char_length(trim(p_value ->> 'default_model_id')), 0) = 0 THEN
        RAISE EXCEPTION 'llm_model_catalog must include nonempty tiers and default_model_id'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        WHERE jsonb_typeof(tier) IS DISTINCT FROM 'object'
          OR COALESCE(tier ->> 'tier', '') NOT IN ('light', 'standard', 'premium')
          OR COALESCE(char_length(trim(tier ->> 'label')), 0) = 0
          OR COALESCE(char_length(trim(tier ->> 'color')), 0) = 0
          OR jsonb_typeof(tier -> 'sort_order') IS DISTINCT FROM 'number'
          OR jsonb_typeof(tier -> 'models') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF (
        SELECT count(*) <> count(DISTINCT tier ->> 'tier')
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog tier keys must be unique'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
        WHERE jsonb_typeof(model) IS DISTINCT FROM 'object'
          OR COALESCE(char_length(trim(model ->> 'id')), 0) = 0
          OR COALESCE(char_length(trim(model ->> 'openrouter_model_id')), 0) = 0
          OR COALESCE(char_length(trim(model ->> 'display_name')), 0) = 0
          OR char_length(COALESCE(model ->> 'tagline', '')) > 15
          OR jsonb_typeof(model -> 'price_input') IS DISTINCT FROM 'number'
          OR jsonb_typeof(model -> 'price_output') IS DISTINCT FROM 'number'
          OR jsonb_typeof(model -> 'enabled') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(model -> 'sort_order') IS DISTINCT FROM 'number'
          OR CASE
               WHEN jsonb_typeof(model -> 'price_input') = 'number'
               THEN (model ->> 'price_input')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(model -> 'price_output') = 'number'
               THEN (model ->> 'price_output')::NUMERIC < 0
               ELSE true
             END
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog contains an invalid model'
          USING ERRCODE = '22023';
      END IF;

      IF (
        SELECT count(*) <> count(DISTINCT model ->> 'id')
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog model ids must be unique'
          USING ERRCODE = '22023';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
        WHERE model ->> 'id' = p_value ->> 'default_model_id'
          AND model -> 'enabled' = 'true'::JSONB
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog default_model_id must identify an enabled model'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'llm_pricing_config' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_value -> 'balanceBaseline') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'fallbackCost') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'exchangeRate') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'markup') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'llm_pricing_config must include four numeric fields'
          USING ERRCODE = '22023';
      END IF;

      IF (p_value ->> 'balanceBaseline')::NUMERIC < 0
         OR (p_value ->> 'fallbackCost')::NUMERIC < 0
         OR (p_value ->> 'exchangeRate')::NUMERIC <= 0
         OR (p_value ->> 'markup')::NUMERIC <= 0 THEN
        RAISE EXCEPTION 'llm_pricing_config values are outside the allowed range'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'system_fallback_character_id' THEN
      IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'system_fallback_character_id must be a UUID JSON string'
          USING ERRCODE = '22023';
      END IF;

      BEGIN
        v_uuid := (p_value #>> '{}')::UUID;
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION 'system_fallback_character_id must be a UUID JSON string'
            USING ERRCODE = '22023';
      END;

    ELSE
      RAISE EXCEPTION 'managed config validation is missing for key: %', p_config_key
        USING ERRCODE = '22023';
  END CASE;

  PERFORM p_text_value;
END;
$l16$);

  SELECT string_agg(l.fn, ', ' ORDER BY l.ord) INTO v_bad FROM p3d_layers l
  WHERE (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure('admin.' || l.fn || '(text,jsonb,text)')) IS DISTINCT FROM l.md5_no_cr;
  SELECT count(*) INTO v_count FROM pg_proc
  WHERE pronamespace = 'admin'::regnamespace AND proname LIKE 'validate\_managed\_config\_value%';
  IF v_bad IS NULL AND v_count = 16 THEN
    RETURN;  -- 与生产一致
  END IF;
  IF admin.current_environment() IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'validator chain differs from production outside TEST (layers: %, count: %); refusing to rebuild',
      coalesce(v_bad, '-'), v_count;
  END IF;
  IF to_regprocedure('admin.validate_image_plaza_video_model_catalog(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'TEST lacks admin.validate_image_plaza_video_model_catalog(jsonb) that the production chain calls';
  END IF;

  RAISE NOTICE 'rebuilding TEST validator chain (differing: %, functions: %)', coalesce(v_bad, '-'), v_count;
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
           WHERE p.pronamespace = 'admin'::regnamespace AND p.proname LIKE 'validate\_managed\_config\_value%' LOOP
    EXECUTE format('DROP FUNCTION %s', r.fn);
  END LOOP;
  FOR r IN SELECT * FROM p3d_layers ORDER BY ord LOOP
    EXECUTE format('CREATE FUNCTION admin.%I(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL) '
                   'RETURNS void LANGUAGE plpgsql STABLE SET search_path TO %L AS %L', r.fn, 'pg_catalog', r.body);
    EXECUTE format('REVOKE ALL ON FUNCTION admin.%I(text, jsonb, text) FROM PUBLIC', r.fn);
  END LOOP;

  SELECT string_agg(l.fn, ', ') INTO v_bad FROM p3d_layers l
  WHERE (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure('admin.' || l.fn || '(text,jsonb,text)')) IS DISTINCT FROM l.md5_no_cr;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'rebuilt layers do not match production: %', v_bad;
  END IF;
END
$align$;

COMMIT;
