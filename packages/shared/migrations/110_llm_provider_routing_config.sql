-- 105_llm_provider_routing_config.sql
--
-- 新增运营可管理的「模型 × 供应商」OpenRouter 路由配置 llm_provider_routing_config，
-- 接入运营台的草稿/发布/回滚流程。
--
-- 背景：同一个 OpenRouter 模型背后有多个底层供应商，质量参差不齐（截断、内容过滤等）。
-- 运营按模型维度维护两类策略，后端生成请求时翻译成 OpenRouter provider routing 参数：
--   rules[].blocked_providers   -> provider.ignore（黑名单，直接屏蔽）
--   rules[].preferred_providers -> provider.order + allow_fallbacks: true（优先，其余兜底）
--
-- 规则以 openrouter_model_id 为键：策略只能绑定具体模型，结构上不存在「全局屏蔽某
-- 供应商」的写法（同一供应商在不同模型上的表现差异极大，不允许全局策略）。
--
-- seed 为空 rules，等于本次迁移不改变任何路由行为；首批规则由运营在平台上发布，
-- 顺便走通整条草稿 -> 发布链路。
--
-- 白名单四处同步遵循 095 的教训：不照抄历史名单，校验总入口只显式处理新 key，
-- 其余委托给当前入口（095 版本，104 已还原）的快照 validate_managed_config_value_before_provider_routing。

BEGIN;

-- ─── 0. 前置检查：委托链上的函数必须都在 ───────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_managed_config_value_before_payment_prompt，请先执行 092';
  END IF;
  IF to_regprocedure('admin.validate_lobby_pinned_characters(jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_lobby_pinned_characters，请先执行 093';
  END IF;
  IF to_regprocedure('admin.validate_payment_prompt_dialog_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_payment_prompt_dialog_config，请先执行 092';
  END IF;
END;
$$;

-- ─── 1. seed（空规则）──────────────────────────────────────────────────────
-- runtime_config 在 099 拆分后归属 app_core，未拆分的库仍在 miniapp，动态解析两处。
DO $$
DECLARE
  runtime_tbl regclass;
BEGIN
  runtime_tbl := COALESCE(
    to_regclass('app_core.runtime_config'),
    to_regclass('miniapp.runtime_config')
  );
  IF runtime_tbl IS NULL THEN
    RAISE EXCEPTION 'runtime_config not found in app_core or miniapp';
  END IF;
  EXECUTE format(
    $sql$
      INSERT INTO %s (key, value, description, version, updated_at)
      VALUES (
        'llm_provider_routing_config',
        '{"rules": []}'::jsonb,
        '「模型 × 供应商」OpenRouter 路由规则：blocked_providers 写入 provider.ignore（屏蔽），'
        'preferred_providers 写入 provider.order 并允许兜底回落。规则按 openrouter_model_id 生效，'
        '空 rules 表示不干预任何模型的默认路由。',
        1,
        now()
      )
      ON CONFLICT (key) DO NOTHING
    $sql$,
    runtime_tbl
  );
END;
$$;

-- ─── 2. managed-config 白名单（四处之三：两张表 CHECK + 可见性开关）────────
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
    'llm_provider_routing_config',
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
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'llm_provider_routing_config',
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
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'llm_provider_routing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters'
  );
$$;

-- ─── 3. 库侧校验 ───────────────────────────────────────────────────────────
-- 与 packages/shared 的 LlmProviderRoutingConfigSchema 同口径。两边都校验不是冗余：
-- Zod 拦运营台路径，库函数拦所有路径（脚本、手工 SQL、将来别的客户端）。

-- 供应商 slug 列表的公共校验：缺省等同空数组（与 shared 的 default([]) 对齐），
-- 返回小写化的 slug 数组供上层做黑白名单交集检查。
CREATE OR REPLACE FUNCTION admin.validate_provider_slug_list(p_list JSONB, p_field TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_item JSONB;
  v_slug TEXT;
  v_slugs TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_list IS NULL OR jsonb_typeof(p_list) = 'null' THEN
    RETURN v_slugs;
  END IF;
  IF jsonb_typeof(p_list) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'llm_provider_routing_config: % must be an array', p_field
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_list) > 20 THEN
    RAISE EXCEPTION 'llm_provider_routing_config: % must not exceed 20 entries', p_field
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_list)
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'llm_provider_routing_config: % must contain only strings', p_field
        USING ERRCODE = '22023';
    END IF;
    v_slug := trim(v_item #>> '{}');
    IF v_slug = ''
       OR char_length(v_slug) > 64
       OR v_slug !~ '^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$' THEN
      RAISE EXCEPTION 'llm_provider_routing_config: % contains an invalid provider slug: %', p_field, v_slug
        USING ERRCODE = '22023';
    END IF;
    IF lower(v_slug) = ANY (v_slugs) THEN
      RAISE EXCEPTION 'llm_provider_routing_config: % must not repeat provider %', p_field, v_slug
        USING ERRCODE = '22023';
    END IF;
    v_slugs := array_append(v_slugs, lower(v_slug));
  END LOOP;
  RETURN v_slugs;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_llm_provider_routing_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_rule JSONB;
  v_model TEXT;
  v_models TEXT[] := ARRAY[]::TEXT[];
  v_blocked TEXT[];
  v_preferred TEXT[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'llm_provider_routing_config must be a JSON object'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'llm_provider_routing_config.rules must be an array'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_value -> 'rules') > 100 THEN
    RAISE EXCEPTION 'llm_provider_routing_config.rules must not exceed 100 entries'
      USING ERRCODE = '22023';
  END IF;

  FOR v_rule IN SELECT value FROM jsonb_array_elements(p_value -> 'rules')
  LOOP
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'llm_provider_routing_config.rules must contain only objects'
        USING ERRCODE = '22023';
    END IF;

    v_model := trim(v_rule ->> 'openrouter_model_id');
    IF v_model IS NULL
       OR char_length(v_model) < 3
       OR char_length(v_model) > 200
       OR v_model !~ '^[^[:space:]/]+/[^[:space:]/]+$' THEN
      RAISE EXCEPTION
        'llm_provider_routing_config: openrouter_model_id must look like vendor/model, got %',
        COALESCE(v_model, '<null>')
        USING ERRCODE = '22023';
    END IF;
    -- 每个模型至多一条规则，否则后端只会命中第一条，运营台看到的和实际生效的会对不上。
    IF lower(v_model) = ANY (v_models) THEN
      RAISE EXCEPTION 'llm_provider_routing_config: duplicate rule for model %', v_model
        USING ERRCODE = '22023';
    END IF;
    v_models := array_append(v_models, lower(v_model));

    v_blocked := admin.validate_provider_slug_list(v_rule -> 'blocked_providers', 'blocked_providers');
    v_preferred := admin.validate_provider_slug_list(v_rule -> 'preferred_providers', 'preferred_providers');

    IF COALESCE(array_length(v_blocked, 1), 0) = 0
       AND COALESCE(array_length(v_preferred, 1), 0) = 0 THEN
      RAISE EXCEPTION
        'llm_provider_routing_config: rule for % must list at least one blocked or preferred provider',
        v_model
        USING ERRCODE = '22023';
    END IF;
    IF v_blocked && v_preferred THEN
      RAISE EXCEPTION
        'llm_provider_routing_config: rule for % lists a provider as both blocked and preferred',
        v_model
        USING ERRCODE = '22023';
    END IF;

    IF v_rule ? 'note' AND jsonb_typeof(v_rule -> 'note') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'llm_provider_routing_config: note must be a string'
        USING ERRCODE = '22023';
    END IF;
    IF char_length(COALESCE(v_rule ->> 'note', '')) > 200 THEN
      RAISE EXCEPTION 'llm_provider_routing_config: note must not exceed 200 characters'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

-- ─── 4. 校验总入口（四处之四）───────────────────────────────────────────────
-- 先把当前入口（095 版本，104 已还原到这个状态）快照成 before_provider_routing，
-- 新入口只显式处理新 key，其余全部委托下沉——照抄历史名单会重演 095 修过的事故。
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value_before_provider_routing(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
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

  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
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
$$;

REVOKE ALL ON FUNCTION admin.validate_provider_slug_list(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_llm_provider_routing_config(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_provider_routing(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 5. 执行后自检：断言不成立就让本次迁移失败回滚 ───────────────────────────
DO $$
DECLARE
  v_def TEXT;
  v_raised BOOLEAN;
  runtime_tbl regclass;
  v_seeded INT;
BEGIN
  -- 1) 新 key 对运营台可见，且没有误抹掉既有 key
  IF NOT admin.is_managed_config_key('llm_provider_routing_config') THEN
    RAISE EXCEPTION '自检失败：is_managed_config_key(llm_provider_routing_config) 返回 false';
  END IF;
  IF NOT admin.is_managed_config_key('lobby_pinned_characters')
     OR NOT admin.is_managed_config_key('miniapp_payment_prompt_dialog_config')
     OR NOT admin.is_managed_config_key('llm_model_catalog') THEN
    RAISE EXCEPTION '自检失败：误把既有 key 从白名单抹掉';
  END IF;

  -- 2) 两张表的 CHECK 都应含新 key 与既有 key
  FOR v_def IN
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
      AND conname LIKE '%config_key_check'
  LOOP
    IF position('llm_provider_routing_config' IN v_def) = 0
       OR position('lobby_pinned_characters' IN v_def) = 0
       OR position('miniapp_payment_prompt_dialog_config' IN v_def) = 0 THEN
      RAISE EXCEPTION '自检失败：CHECK 约束缺少 key -> %', v_def;
    END IF;
  END LOOP;

  -- 3) 新分支可达：text_value 守卫探针
  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('llm_provider_routing_config', '{"rules": []}'::jsonb, 'probe');
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
    IF position('must not use text_value' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION '自检失败：llm_provider_routing_config 没走到自己的分支，实际报错为 %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：llm_provider_routing_config 的 text_value 守卫失效';
  END IF;

  -- 4) 合法值应通过：空 rules 与典型规则
  PERFORM admin.validate_managed_config_value('llm_provider_routing_config', '{"rules": []}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value(
    'llm_provider_routing_config',
    '{"rules": [{"openrouter_model_id": "deepseek/deepseek-chat-v3.2", "blocked_providers": ["alibaba"], "preferred_providers": [], "note": "probe"}]}'::jsonb,
    NULL
  );

  -- 5) 非法值应拦下：规则既不屏蔽也不优先
  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'llm_provider_routing_config',
      '{"rules": [{"openrouter_model_id": "a/b", "blocked_providers": [], "preferred_providers": []}]}'::jsonb,
      NULL
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：空规则被静默放过';
  END IF;

  -- 6) 委托下沉链未断：老 key 仍走到原有校验
  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：校验链下沉断了，system_instructions 放过了空值';
  END IF;

  -- 7) seed 行已存在
  runtime_tbl := COALESCE(
    to_regclass('app_core.runtime_config'),
    to_regclass('miniapp.runtime_config')
  );
  EXECUTE format(
    'SELECT count(*) FROM %s WHERE key = ''llm_provider_routing_config''',
    runtime_tbl
  ) INTO v_seeded;
  IF v_seeded <> 1 THEN
    RAISE EXCEPTION '自检失败：runtime_config 缺少 llm_provider_routing_config 的 seed 行';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.validate_llm_provider_routing_config(JSONB) IS
  '校验「模型 × 供应商」路由配置：rules 数组按 openrouter_model_id 去重，每条至少一个'
  '屏蔽或优先供应商，供应商 slug 列表内去重且黑白名单不得交叉。';
COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Managed config validation entry point. Handles llm_provider_routing_config, then defers to the pre-105 snapshot.';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证已内联为上面的自检断言：迁移跑通即代表四处声明齐、新分支可达、下沉链未断、seed 已落。
--
-- 回滚：
--   BEGIN;
--   DELETE FROM admin.config_releases WHERE config_key = 'llm_provider_routing_config';
--   DELETE FROM admin.config_drafts   WHERE config_key = 'llm_provider_routing_config';
--   DELETE FROM app_core.runtime_config WHERE key = 'llm_provider_routing_config';  -- 未拆分库用 miniapp.runtime_config
--   -- 校验总入口还原为 095 版本（即本文件 before_provider_routing 快照的函数体），
--   -- 再删掉 validate_llm_provider_routing_config / validate_provider_slug_list /
--   -- validate_managed_config_value_before_provider_routing，
--   -- 最后按 104 的名单（去掉 llm_provider_routing_config）重建两张表 CHECK 与 is_managed_config_key。
--   COMMIT;
