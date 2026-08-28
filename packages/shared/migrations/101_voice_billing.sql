-- 101_voice_billing.sql
--
-- 语音付费与 300 字限制：给已上线的语音模块补「付费闸」。
--
-- 计费口径（PRD 已拍板）：
--   - 每次「生成语音」成功（音频可播后）扣 15 星尘；重新生成视为新的一次，成功再扣 15。
--   - 超限、写稿失败、TTS 失败一律不扣；写稿 LLM 成本由平台承担，不走 charge_llm_usage。
--   - 「只有听到（可播放）才会扣」对齐对话「未见 [DONE] 不扣」。
--
-- 为什么不复用 charge_llm_usage：该 RPC 强制 OpenRouter model catalog 字段
--（model_openrouter_id / catalog_version / 定档金额），语音对不上。语音的「账单」
-- 就是 chat_message_audio 行本身——加 credits_charged / charge_id 两列即可，
-- 不另建语音账单表。wallet_ledger 用 reference_type='voice_usage' 与 llm_usage 区分。
--
-- wallet_ledger 无需改约束：reference_type 是无约束 TEXT（016 建表），
-- entry_type 的 CHECK 已含 chat_debit（086 放开 wish_reward 时一并保留）。
--
-- 计费开关 voice_billing_enabled：测试环境 true，生产默认 false，直到经年确认上线。
-- 开关关闭时受理阶段不做 402 预检、后台不扣费，行为与现网完全一致。
-- 长度闸（300）与计费开关解耦：开关关也仍拦超长 TTS（超长 TTS 是成本）。
--
-- managed-config 白名单与校验总入口的写法遵循仓库惯例：以 093 落库后的实际并集为基础
-- 追加 voice_*，并顺手补齐 093 抹掉的 miniapp_payment_prompt_dialog_config（092 加过、
-- 093 重声明时漏掉）。总入口显式拦 voice_* 与 payment_prompt 分支，其余分支与 093 保持
-- 逐字一致并下沉到 validate_managed_config_value_before_fixed_billing。
-- 少抄一段就等于删掉一个 key 的校验。

BEGIN;

-- ─── 1. chat_message_audio 加列 ───────────────────────────────────────────
ALTER TABLE miniapp.chat_message_audio
  ADD COLUMN IF NOT EXISTS credits_charged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE miniapp.chat_message_audio
  ADD COLUMN IF NOT EXISTS charge_id UUID;

COMMENT ON COLUMN miniapp.chat_message_audio.credits_charged IS
  '本次生成实扣星尘：成功为 voice_generation_credits（默认 15），失败/未扣费为 0。'
  '与 wallet_ledger 的 voice_usage 行一一对应（reference_id = charge_id）。';
COMMENT ON COLUMN miniapp.chat_message_audio.charge_id IS
  '扣费幂等键，一般等于本行 id。NULL 表示本次未扣费（开关关或失败）。';

CREATE INDEX IF NOT EXISTS idx_chat_message_audio_charge
  ON miniapp.chat_message_audio (charge_id)
  WHERE charge_id IS NOT NULL;

-- ─── 2. charge_voice_usage RPC ────────────────────────────────────────────
-- 幂等键 = chat_message_audio.id（每次生成一行，天然一费一单）。
-- 余额不足返回明确状态，供 generate.ts 走 Q4：音频给听、credits_charged=0、人工补扣。
CREATE OR REPLACE FUNCTION miniapp.charge_voice_usage(
  p_charge_key UUID,
  p_user_id UUID,
  p_audio_id UUID,
  p_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet miniapp.user_wallets;
  v_existing_ledger_id UUID;
  v_amount NUMERIC(14,1) := round(GREATEST(COALESCE(p_amount, 0), 0), 1);
  v_available NUMERIC(14,1);
  v_charged NUMERIC(14,1);
  v_bonus_to_deduct NUMERIC(14,1);
  v_main_to_deduct NUMERIC(14,1);
  v_ledger_id UUID;
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL OR p_audio_id IS NULL
     OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid voice usage charge input' USING ERRCODE = '22023';
  END IF;

  -- 幂等：同一 charge_key 已有 voice_usage 流水则不重复扣
  SELECT id INTO v_existing_ledger_id
  FROM miniapp.wallet_ledger
  WHERE reference_type = 'voice_usage' AND reference_id = p_charge_key::TEXT
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    SELECT * INTO v_wallet
    FROM miniapp.user_wallets
    WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet),
      'charge_id', p_charge_key,
      'ledger_id', v_existing_ledger_id
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

  -- Q4：TTS 已成功、扣费时余额被对话回合花光。不抛错（抛了没人接得住，
  -- HTTP 响应早发完），返回 insufficient_balance 让 generate.ts 仍 markReady 给听、
  -- 打 error 日志、人工补扣。不出现「扣了费但没音频」。
  IF v_available < v_amount THEN
    RETURN jsonb_build_object(
      'charge_status', 'insufficient_balance',
      'wallet', to_jsonb(v_wallet),
      'charge_id', NULL,
      'ledger_id', NULL,
      'required', v_amount,
      'available', v_available
    );
  END IF;

  v_charged := v_amount;
  v_bonus_to_deduct := LEAST(v_wallet.bonus_credits, v_charged);
  v_main_to_deduct := v_charged - v_bonus_to_deduct;

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
    v_wallet.main_credits, v_wallet.bonus_credits, 'voice_usage', p_charge_key::TEXT,
    COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
      'audio_id', p_audio_id,
      'charged_amount', v_charged
    )
  ) RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'charge_status', 'charged',
    'wallet', to_jsonb(v_wallet),
    'charge_id', p_charge_key,
    'ledger_id', v_ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION miniapp.charge_voice_usage(UUID, UUID, UUID, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp.charge_voice_usage(UUID, UUID, UUID, NUMERIC, JSONB)
  TO service_role, postgres;

COMMENT ON FUNCTION miniapp.charge_voice_usage(
  UUID, UUID, UUID, NUMERIC, JSONB
) IS
  'Idempotently charges 15 credits for a successful voice generation. '
  'Keyed by chat_message_audio.id. Returns insufficient_balance (no deduction) '
  'when balance was spent by a concurrent turn, so the audio can still be marked ready.';

-- ─── 3. runtime_config 种子 ───────────────────────────────────────────────
-- 7 个独立标量键。测试环境后续手动把 voice_billing_enabled 置 true。
INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at, text_value)
VALUES
  ('voice_billing_enabled', 'false'::JSONB,
   '语音付费开关：true 时受理阶段做 402 预检、后台见到可播音频扣 voice_generation_credits；false 时行为与现网一致（免费）。长度闸与该开关解耦。',
   1, now(), NULL),
  ('voice_generation_credits', '15'::JSONB,
   '单次语音生成成功后扣费额（星尘）。重新生成视为新的一次，成功再扣。',
   1, now(), NULL),
  ('voice_max_spoken_chars', '300'::JSONB,
   '送进 TTS 的最终文本上限（字）。自定义输入与写稿成品共用，口径与现网自定义上限一致（string.length）。',
   1, now(), NULL),
  ('voice_price_label', '"15 星尘"'::JSONB,
   '生成语音入口旁展示的价格文案，前端只读不写死。改价时同步改 voice_generation_credits。',
   1, now(), NULL),
  ('voice_over_limit_hint', '"文字处理后的语音文本超过 300 字，请删减或缩改后再生成"'::JSONB,
   '终检 >voice_max_spoken_chars 时当前角色消息底部红字（PRD 原句）。',
   1, now(), NULL),
  ('voice_draft_failed_hint', '"本次未生成，请稍后重试"'::JSONB,
   '写稿失败/无可朗读内容时当前角色消息底部小字。',
   1, now(), NULL),
  ('voice_tts_failed_hint', '"语音生成失败，请重试"'::JSONB,
   'TTS 失败时当前角色消息底部小字（与超限那句区分，提示可重试）。',
   1, now(), NULL)
ON CONFLICT (key) DO NOTHING;

-- ─── 4. managed-config 白名单 ─────────────────────────────────────────────
-- 以 093 落库后的并集为基础，追加 miniapp_payment_prompt_dialog_config（093 漏掉的）
-- 与 7 个 voice_* 键。三处必须同步：两张表的 CHECK 决定草稿/发布记录能不能落，
-- is_managed_config_key 决定 get_managed_configs 会不会把它返回给运营台。
ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'voice_billing_enabled',
    'voice_generation_credits',
    'voice_max_spoken_chars',
    'voice_price_label',
    'voice_over_limit_hint',
    'voice_draft_failed_hint',
    'voice_tts_failed_hint'
  ));

ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases
  ADD CONSTRAINT config_releases_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'voice_billing_enabled',
    'voice_generation_credits',
    'voice_max_spoken_chars',
    'voice_price_label',
    'voice_over_limit_hint',
    'voice_draft_failed_hint',
    'voice_tts_failed_hint'
  ));

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'voice_billing_enabled',
    'voice_generation_credits',
    'voice_max_spoken_chars',
    'voice_price_label',
    'voice_over_limit_hint',
    'voice_draft_failed_hint',
    'voice_tts_failed_hint'
  );
$$;

-- ─── 5. 库侧校验 ─────────────────────────────────────────────────────────
-- 与 packages/admin 的 Zod schema 同口径。两边都校验不是冗余：
-- Zod 拦运营台这条路径，库函数拦所有路径（脚本、手工 SQL）。
CREATE OR REPLACE FUNCTION admin.validate_voice_config_value(
  p_config_key TEXT,
  p_value JSONB
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'voice_billing_enabled' THEN
    IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'voice_billing_enabled must be a JSON boolean'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN ('voice_generation_credits', 'voice_max_spoken_chars') THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION '% must be a positive JSON integer', p_config_key
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN ('voice_price_label', 'voice_over_limit_hint',
                      'voice_draft_failed_hint', 'voice_tts_failed_hint') THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'string'
       OR char_length(trim(p_value #>> '{}')) = 0 THEN
      RAISE EXCEPTION '% must be a nonempty JSON string', p_config_key
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'unknown voice config key: %', p_config_key
    USING ERRCODE = '22023';
END;
$$;

-- 重新声明总入口，插入 voice_* 与 miniapp_payment_prompt_dialog_config 分支。
-- 其余分支与 093 保持逐字一致——这个函数是 CREATE OR REPLACE，漏掉哪个分支
-- 就等于把那个 key 的校验删掉。miniapp_payment_prompt_dialog_config 调 092 建好的
-- admin.validate_payment_prompt_dialog_config。
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_config_key IN ('voice_billing_enabled', 'voice_generation_credits',
                     'voice_max_spoken_chars', 'voice_price_label',
                     'voice_over_limit_hint', 'voice_draft_failed_hint',
                     'voice_tts_failed_hint') THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_voice_config_value(p_config_key, p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;

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

  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
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
$$;

REVOKE ALL ON FUNCTION admin.validate_voice_config_value(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION admin.validate_voice_config_value(TEXT, JSONB) IS
  '校验 7 个语音计费/文案键：billing_enabled 为布尔，credits/max_spoken_chars 为正整数，'
  '四个文案为非空字符串。';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证：
--   SELECT key, value FROM miniapp.runtime_config WHERE key LIKE 'voice_%';
--   SELECT admin.is_managed_config_key('voice_billing_enabled');  -> true
--   SELECT admin.is_managed_config_key('miniapp_payment_prompt_dialog_config');  -> true
--   SELECT admin.validate_voice_config_value('voice_billing_enabled', 'true'::jsonb);   -> ok
--   SELECT admin.validate_voice_config_value('voice_generation_credits', '0'::jsonb);  -> 报错
--   SELECT admin.validate_voice_config_value('voice_price_label', '""'::jsonb);         -> 报错
--
-- 回滚：
--   BEGIN;
--   DELETE FROM admin.config_releases WHERE config_key LIKE 'voice_%';
--   DELETE FROM admin.config_drafts   WHERE config_key LIKE 'voice_%';
--   DELETE FROM miniapp.runtime_config WHERE key LIKE 'voice_%';
--   DROP FUNCTION IF EXISTS admin.validate_voice_config_value(TEXT, JSONB);
--   DROP FUNCTION IF EXISTS miniapp.charge_voice_usage(UUID, UUID, UUID, NUMERIC, JSONB);
--   DROP INDEX IF EXISTS miniapp.idx_chat_message_audio_charge;
--   ALTER TABLE miniapp.chat_message_audio DROP COLUMN IF EXISTS charge_id;
--   ALTER TABLE miniapp.chat_message_audio DROP COLUMN IF EXISTS credits_charged;
--   -- 然后重新执行 093 里的 validate_managed_config_value / is_managed_config_key
--   -- 与两张表的 CHECK（去掉 voice_* 与 miniapp_payment_prompt_dialog_config）。
--   COMMIT;
