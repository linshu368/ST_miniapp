-- 093_lobby_pinned_characters_config.sql
--
-- 把首页「推荐」页的前八张卡交还给运营，通过 miniapp.runtime_config 配置，
-- 接入运营台的草稿/发布/回滚流程。
--
-- 背景：v2 的「运营固定前八」取的是角色卡布局 sort_order 的前八，换卡要去改布局顺序，
-- 顺带把整张列表的次级顺序一起动了。v3 把固定位整个去掉，前八完全由 D30/R48 分数跑出来，
-- 于是运营失去了「这周主推哪八张」的手段。本次两者都要：前八由运营点选，第九张起仍按 v3。
--
-- 存 id 而不是存 sort_order 位次：位次会随任何一次布局调整漂移，
-- 运营点的是「秦若岚」，不是「第 3 位那张」。
--
-- seed 为空数组，等于本次迁移不改变任何卡的位置；运营在平台上点选后才生效。
-- 空数组同时是关掉固定位的开关，退回纯 v3 排序。
--
-- 不校验 id 是否真的存在：这个函数必须是 IMMUTABLE 才能进 validate_managed_config_value，
-- 查表就做不到。读路径按「配了但不在候选池里就跳过」处理，所以下架、归档、删卡
-- 都不会把首页打空，运营台的选卡器也只从真实在架卡里选。

BEGIN;

-- ─── 1. seed ───────────────────────────────────────────────────────────────
INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at)
VALUES (
  'lobby_pinned_characters',
  jsonb_build_object('character_ids', '[]'::jsonb),
  '首页「推荐」页运营固定位：按顺序占据前几个位置，最多 8 张，第九张起按 v3 排序分。'
  '空数组表示不固定，完全交给排序分。改动即时生效，不必等排序刷新。',
  1,
  now()
)
ON CONFLICT (key) DO NOTHING;

-- ─── 2. managed-config 白名单 ──────────────────────────────────────────────
-- 三处必须同步：两张表的 CHECK 决定草稿/发布记录能不能落，
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
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters'
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
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters'
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
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters'
  );
$$;

-- ─── 3. 库侧校验 ───────────────────────────────────────────────────────────
-- 与 packages/shared 的 LobbyPinnedCharactersSchema 同口径。两边都校验不是冗余：
-- Zod 拦的是运营台这条路径，库函数拦的是所有路径（脚本、手工 SQL、将来别的客户端）。
CREATE OR REPLACE FUNCTION admin.validate_lobby_pinned_characters(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  -- 上限跟 shared 的 LOBBY_FEATURED_POSITION_COUNT 对齐：固定位就是金框位，
  -- 配到第 9 张就有卡拿不到金框，位置和样式会对不上。
  v_max_pinned CONSTANT INT := 8;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_item JSONB;
  v_id TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'lobby_pinned_characters must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_value -> 'character_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'lobby_pinned_characters.character_ids must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_value -> 'character_ids') > v_max_pinned THEN
    RAISE EXCEPTION 'lobby_pinned_characters.character_ids must not exceed % entries', v_max_pinned
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value -> 'character_ids')
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'lobby_pinned_characters.character_ids must contain only strings'
        USING ERRCODE = '22023';
    END IF;

    v_id := trim(v_item #>> '{}');

    IF v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'lobby_pinned_characters.character_ids must contain character UUIDs, got %', v_id
        USING ERRCODE = '22023';
    END IF;

    -- 同一张卡占两个固定位时，读路径去重后实际固定位会少一个，
    -- 运营在平台上看到的却是八个，所以这里直接拦掉。
    IF v_id = ANY (v_ids) THEN
      RAISE EXCEPTION 'lobby_pinned_characters.character_ids must be unique, % appears twice', v_id
        USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_id);
  END LOOP;
END;
$$;

-- 重新声明总入口，插入 lobby_pinned_characters 分支。
-- 其余分支与 088 保持逐字一致——这个函数是 CREATE OR REPLACE，漏掉哪个分支
-- 就等于把那个 key 的校验删掉。
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

REVOKE ALL ON FUNCTION admin.validate_lobby_pinned_characters(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION admin.validate_lobby_pinned_characters(JSONB) IS
  '校验首页推荐运营固定位：character_ids 为最多 8 个互不重复的角色卡 UUID。'
  '不校验 id 是否存在，读路径会跳过不在候选池里的卡。';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证：
--   SELECT value FROM miniapp.runtime_config WHERE key = 'lobby_pinned_characters';
--     -> {"character_ids": []}
--   SELECT admin.is_managed_config_key('lobby_pinned_characters');  -> true
--   -- 应当报错（超过 8 张 / 重复 / 非 UUID）：
--   SELECT admin.validate_lobby_pinned_characters('{"character_ids":["not-a-uuid"]}'::jsonb);
--
-- 回滚：
--   BEGIN;
--   DELETE FROM admin.config_releases WHERE config_key = 'lobby_pinned_characters';
--   DELETE FROM admin.config_drafts   WHERE config_key = 'lobby_pinned_characters';
--   DELETE FROM miniapp.runtime_config WHERE key = 'lobby_pinned_characters';
--   DROP FUNCTION IF EXISTS admin.validate_lobby_pinned_characters(JSONB);
--   -- 然后重新执行 088 里的 validate_managed_config_value / is_managed_config_key
--   -- 与两张表的 CHECK（去掉 lobby_pinned_characters）。
--   COMMIT;
