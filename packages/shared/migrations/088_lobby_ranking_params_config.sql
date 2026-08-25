-- 088_lobby_ranking_params_config.sql
--
-- 把首页「推荐」v3 打分参数搬进 miniapp.runtime_config，接入运营台的
-- 草稿/发布/回滚流程。
--
-- 背景：这 13 个参数原来是 backend features/lobby/ranking-score.ts 与 ranking-stats.ts
-- 里的 export const，运营想调权重或门槛必须提代码、走一次发版。而这些值本质是运营口径
-- （深度和留存哪个更重要、多少样本才算可信），不是工程实现细节。
--
-- seed 值与搬迁前的常量逐个等值，所以本次迁移 + 配套代码不改变任何卡的分数。
-- 唯一与设计文档不同的是 first_touch_lookback_days：文档默认 90，线上实现一直是
-- 全历史回看（null）。全历史更准——chat_history 从不清理，「首次交互落在窗口内」是
-- 精确判定；给它加上界会让真实首触早于该范围的老用户被当成新客混进 R48 分母。
-- 所以 seed 保持线上行为，把 90 留给「样本大到刷新超时」时再启用。
--
-- 参数不落 miniapp.character_ranking_scores：那张表存的是算出来的分，
-- 参数属于配置，两者生命周期不同（配置改一次、分数每天重算）。

BEGIN;

-- ─── 1. seed ───────────────────────────────────────────────────────────────
INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at)
VALUES (
  'lobby_ranking_params',
  jsonb_build_object(
    'window_days', 80,
    'turn_cap', 30,
    'session_gap_minutes', 30,
    'return_window_hours', 48,
    'first_touch_lookback_days', NULL,
    'd30_weight', 0.75,
    'r48_weight', 0.25,
    'd30_prior_weight', 20,
    'min_users', 20,
    'r48_full_trust_sample', 40,
    'neutral_norm', 0.5,
    'norm_percentile_low', 0.1,
    'norm_percentile_high', 0.9
  ),
  '首页「推荐」v3 打分参数：统计窗口、轮次上限、会话切分、回访窗口、D30/R48 权重与样本门槛。改动在下一次排序刷新（每 24 小时）生效。',
  1,
  now()
)
ON CONFLICT (key) DO NOTHING;

-- ─── 2. 汇总表记下本轮用的主池门槛 ─────────────────────────────────────────
-- 读路径（buildRecommendedOrder）要按 n_c ≥ 门槛分主池/冷启动池。门槛现在可以被运营
-- 改动，如果读路径自己去查配置，就会出现「分数按旧门槛算、分池按新门槛分」的一天：
-- 运营把 20 调到 200，首页当场把几乎所有卡打进冷启动池随机化，而分数还是按 20 算的。
-- 所以门槛跟着分数一起落表，和 window_days 一样，改动统一在下一次刷新生效。
ALTER TABLE miniapp.character_ranking_scores
  ADD COLUMN IF NOT EXISTS min_users INTEGER NOT NULL DEFAULT 20;

COMMENT ON COLUMN miniapp.character_ranking_scores.min_users IS
  '算这批分数时用的主池硬门槛（n_c ≥ min_users 才进主池）。读路径按这一列分池，保证与分数同版。';

-- ─── 3. managed-config 白名单 ──────────────────────────────────────────────
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
    'lobby_ranking_params'
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
    'lobby_ranking_params'
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
    'lobby_ranking_params'
  );
$$;

-- ─── 4. 库侧校验 ───────────────────────────────────────────────────────────
-- 与 packages/shared 的 LobbyRankingParamsSchema 同口径。两边都校验不是冗余：
-- Zod 拦的是运营台这条路径，库函数拦的是所有路径（脚本、手工 SQL、将来别的客户端）。
CREATE OR REPLACE FUNCTION admin.validate_lobby_ranking_params(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  -- 字段名 → [下界, 上界, 是否必须为整数(1/0)]
  v_specs JSONB := jsonb_build_array(
    jsonb_build_array('window_days', 1, 365, 1),
    jsonb_build_array('turn_cap', 1, 1000, 1),
    jsonb_build_array('session_gap_minutes', 1, 1440, 1),
    jsonb_build_array('return_window_hours', 1, 720, 1),
    jsonb_build_array('d30_weight', 0, 1, 0),
    jsonb_build_array('r48_weight', 0, 1, 0),
    jsonb_build_array('d30_prior_weight', 0, 100000, 0),
    jsonb_build_array('min_users', 1, 1000000, 1),
    jsonb_build_array('r48_full_trust_sample', 1, 1000000, 1),
    jsonb_build_array('neutral_norm', 0, 1, 0),
    jsonb_build_array('norm_percentile_low', 0, 1, 0),
    jsonb_build_array('norm_percentile_high', 0, 1, 0)
  );
  v_spec JSONB;
  v_name TEXT;
  v_num NUMERIC;
  v_lookback NUMERIC;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'lobby_ranking_params must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  FOR v_spec IN SELECT value FROM jsonb_array_elements(v_specs)
  LOOP
    v_name := v_spec ->> 0;

    IF jsonb_typeof(p_value -> v_name) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'lobby_ranking_params.% must be a number', v_name
        USING ERRCODE = '22023';
    END IF;

    v_num := (p_value ->> v_name)::NUMERIC;

    IF v_num < (v_spec ->> 1)::NUMERIC OR v_num > (v_spec ->> 2)::NUMERIC THEN
      RAISE EXCEPTION 'lobby_ranking_params.% must be between % and %',
        v_name, v_spec ->> 1, v_spec ->> 2
        USING ERRCODE = '22023';
    END IF;

    IF (v_spec ->> 3)::INT = 1 AND v_num <> trunc(v_num) THEN
      RAISE EXCEPTION 'lobby_ranking_params.% must be an integer', v_name
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- null 是有效取值，表示「回看全历史」，所以单独校验而不进上面的循环。
  IF NOT p_value ? 'first_touch_lookback_days' THEN
    RAISE EXCEPTION 'lobby_ranking_params.first_touch_lookback_days is required (use null for unlimited)'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'first_touch_lookback_days') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'lobby_ranking_params.first_touch_lookback_days must be a number or null'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'first_touch_lookback_days') = 'number' THEN
    v_lookback := (p_value ->> 'first_touch_lookback_days')::NUMERIC;
    IF v_lookback < 1 OR v_lookback > 3650 OR v_lookback <> trunc(v_lookback) THEN
      RAISE EXCEPTION 'lobby_ranking_params.first_touch_lookback_days must be an integer between 1 and 3650'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 权重和不为 1 时分数不再落在 0–100，会推翻「score 是百分制」这个既有口径，
  -- 而运营对分数的直觉、以及所有历史分数的可比性都建立在它上面。
  IF abs(
       (p_value ->> 'd30_weight')::NUMERIC + (p_value ->> 'r48_weight')::NUMERIC - 1
     ) > 0.000001 THEN
    RAISE EXCEPTION 'lobby_ranking_params d30_weight + r48_weight must equal 1'
      USING ERRCODE = '22023';
  END IF;

  -- 低位 >= 高位时归一化区间宽度为 0 或负，所有卡会被推到极端值。
  IF (p_value ->> 'norm_percentile_low')::NUMERIC
     >= (p_value ->> 'norm_percentile_high')::NUMERIC THEN
    RAISE EXCEPTION 'lobby_ranking_params norm_percentile_low must be less than norm_percentile_high'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

-- 重新声明总入口，插入 lobby_ranking_params 分支。
-- 其余分支与 085 保持逐字一致——这个函数是 CREATE OR REPLACE，漏掉哪个分支
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

REVOKE ALL ON FUNCTION admin.validate_lobby_ranking_params(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION admin.validate_lobby_ranking_params(JSONB) IS
  '校验首页推荐 v3 打分参数：各项取值范围、权重和为 1、分位点低位小于高位。'
  'first_touch_lookback_days 允许 null，语义是回看全历史。';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 回滚：
--   BEGIN;
--   DELETE FROM admin.config_releases WHERE config_key = 'lobby_ranking_params';
--   DELETE FROM admin.config_drafts   WHERE config_key = 'lobby_ranking_params';
--   DELETE FROM miniapp.runtime_config WHERE key = 'lobby_ranking_params';
--   DROP FUNCTION IF EXISTS admin.validate_lobby_ranking_params(JSONB);
--   ALTER TABLE miniapp.character_ranking_scores DROP COLUMN IF EXISTS min_users;
--   -- 然后重新执行 085 里的 validate_managed_config_value 与 076 里的
--   -- is_managed_config_key / 两张表的 CHECK（去掉 lobby_ranking_params）。
--   COMMIT;
