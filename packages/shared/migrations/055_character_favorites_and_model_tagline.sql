-- 055: 角色卡收藏（从零新增）与模型介绍语长度放宽
--
-- 目标：
--   1. 新增 miniapp.character_favorites，承载「用户 → 角色卡」收藏关系。
--      同一用户对同一张卡最多一条记录，由主键保证，重复点击不会产生重复收藏。
--   2. 提供 SECURITY DEFINER RPC 供后端 service_role 调用：切换收藏、读取收藏列表。
--      收藏列表只返回仍然可用（enabled 且未归档）的角色卡，避免下架卡进入用户收藏页。
--   3. 把模型介绍语 tagline 的长度上限从 15 放宽到 40。
--      原上限只能容纳「轻巧流畅」这类 4 字空泛词，无法表达适用场景。
--
-- 说明：编号 052 曾用于一版已删除的收藏实现，本迁移不依赖也不恢复该版本。
-- 全文件幂等，可重复执行。

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. 收藏关系表
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS miniapp.character_favorites (
  user_id      UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, character_id)
);

-- 收藏列表按用户 + 收藏时间倒序读取。
CREATE INDEX IF NOT EXISTS idx_character_favorites_user_created
  ON miniapp.character_favorites(user_id, created_at DESC);

ALTER TABLE miniapp.character_favorites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.character_favorites FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.character_favorites TO service_role, postgres;

COMMENT ON TABLE miniapp.character_favorites IS
  'MiniApp 用户角色卡收藏关系。主键 (user_id, character_id) 保证同一张卡不重复收藏。';

-- ─────────────────────────────────────────────────────────────
-- 2. 收藏读写 RPC
-- ─────────────────────────────────────────────────────────────

-- 切换收藏状态。幂等：重复收藏或重复取消都收敛到目标状态。
CREATE OR REPLACE FUNCTION miniapp.set_character_favorite(
  p_user_id UUID,
  p_character_id UUID,
  p_favorited BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_available BOOLEAN;
BEGIN
  IF p_user_id IS NULL OR p_character_id IS NULL OR p_favorited IS NULL THEN
    RAISE EXCEPTION 'invalid character favorite input'
      USING ERRCODE = '22023';
  END IF;

  -- 同一用户对同一张卡的并发点击串行化，避免快速重复点击互相覆盖。
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::TEXT || ':' || p_character_id::TEXT, 0)
  );

  IF p_favorited THEN
    SELECT EXISTS (
      SELECT 1
      FROM miniapp.characters
      WHERE id = p_character_id
        AND enabled = true
        AND archived_at IS NULL
    ) INTO v_available;

    IF NOT v_available THEN
      RAISE EXCEPTION 'character is unavailable: %', p_character_id
        USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO miniapp.character_favorites(user_id, character_id)
    VALUES (p_user_id, p_character_id)
    ON CONFLICT (user_id, character_id) DO NOTHING;
  ELSE
    DELETE FROM miniapp.character_favorites
    WHERE user_id = p_user_id
      AND character_id = p_character_id;
  END IF;

  RETURN jsonb_build_object(
    'character_id', p_character_id,
    'favorited', p_favorited
  );
END;
$$;

-- 读取某用户的收藏，过滤已下架 / 已归档角色卡。
CREATE OR REPLACE FUNCTION miniapp.list_character_favorites(
  p_user_id UUID
) RETURNS TABLE(character_id UUID, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT favorites.character_id, favorites.created_at
  FROM miniapp.character_favorites AS favorites
  JOIN miniapp.characters AS characters
    ON characters.id = favorites.character_id
  WHERE favorites.user_id = p_user_id
    AND characters.enabled = true
    AND characters.archived_at IS NULL
  ORDER BY favorites.created_at DESC
$$;

REVOKE ALL ON FUNCTION miniapp.set_character_favorite(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION miniapp.list_character_favorites(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION miniapp.set_character_favorite(UUID, UUID, BOOLEAN)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.list_character_favorites(UUID)
  TO service_role, postgres;

COMMENT ON FUNCTION miniapp.set_character_favorite(UUID, UUID, BOOLEAN) IS
  '切换角色卡收藏状态；幂等，收藏前校验角色卡仍然可用。';
COMMENT ON FUNCTION miniapp.list_character_favorites(UUID) IS
  '按收藏时间倒序返回用户收藏的可用角色卡 id。';

-- ─────────────────────────────────────────────────────────────
-- 3. 模型介绍语长度上限 15 → 40
--
-- 两个校验函数都会拦截 tagline 长度，必须同步放宽，否则运营在 Admin
-- 保存场景化介绍语（约 17-21 字）会被拒绝。Postgres 无法只替换函数中的
-- 单个表达式，因此整体 CREATE OR REPLACE，仅 tagline 上限一处发生变化。
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin.validate_model_catalog_prd(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE trim(tier ->> 'label') = ''
      OR char_length(trim(tier ->> 'label')) > 20
      OR COALESCE(tier ->> 'color', '') !~ '^#[0-9A-Fa-f]{6}$'
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 30
      OR jsonb_array_length(tier -> 'models') = 0
      OR (tier ->> 'sort_order')::NUMERIC < 0
      OR (tier ->> 'sort_order')::NUMERIC <> trunc((tier ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD tier fields'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE COALESCE(model ->> 'id', '') !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
      OR char_length(model ->> 'id') > 64
      OR COALESCE(model ->> 'openrouter_model_id', '') !~ '^[^[:space:]/]+/[^[:space:]/]+$'
      OR char_length(model ->> 'openrouter_model_id') > 200
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) NOT BETWEEN 1 AND 40
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 40
      OR (model ->> 'price_input')::NUMERIC * 10
         <> trunc((model ->> 'price_input')::NUMERIC * 10)
      OR (model ->> 'price_output')::NUMERIC * 10
         <> trunc((model ->> 'price_output')::NUMERIC * 10)
      OR jsonb_typeof(model -> 'markup') IS DISTINCT FROM 'number'
      OR (model ->> 'markup')::NUMERIC NOT IN (0, 1, 1.5, 2, 2.5, 3, 3.5, 4)
      OR (
        (model ->> 'markup')::NUMERIC = 0
        AND (
          (model ->> 'price_input')::NUMERIC <> 0
          OR (model ->> 'price_output')::NUMERIC <> 0
        )
      )
      OR (model ->> 'sort_order')::NUMERIC < 0
      OR (model ->> 'sort_order')::NUMERIC <> trunc((model ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD model fields'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT model ->> 'openrouter_model_id')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog OpenRouter mappings must be unique'
      USING ERRCODE = '22023';
  END IF;
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
          OR char_length(COALESCE(model ->> 'tagline', '')) > 40
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
$$;

-- ─────────────────────────────────────────────────────────────
-- 4. 把仍是初始 4 字空泛词的介绍语换成场景化短句
--
-- 只在 tagline 与 040 的初始种子值完全一致时替换，运营改过的文案不动。
-- 最终文案仍由业务确认，后续在 Admin 覆盖即可，不需要再改代码。
-- ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_seeded  JSONB := jsonb_build_object(
    'gemini-flash-lite', '轻巧流畅',
    'deepseek-v3.2',     '推理均衡',
    'glm-5.2',           '中文细腻',
    'gemini-3.1-pro',    '旗舰沉浸'
  );
  v_replacement JSONB := jsonb_build_object(
    'gemini-flash-lite', '适合日常角色对话，回复快、消耗低。',
    'deepseek-v3.2',     '适合推理和剧情推进，逻辑连贯稳定。',
    'glm-5.2',           '适合中文细节描写，语气自然贴近角色。',
    'gemini-3.1-pro',    '适合长上下文和多轮连续对话。'
  );
BEGIN
  UPDATE miniapp.runtime_config AS target
  SET value = jsonb_set(
        target.value,
        '{tiers}',
        (
          SELECT jsonb_agg(
                   jsonb_set(
                     tier.value,
                     '{models}',
                     (
                       SELECT jsonb_agg(
                                CASE
                                  WHEN v_replacement ? (model.value ->> 'id')
                                   AND model.value ->> 'tagline'
                                       = (v_seeded ->> (model.value ->> 'id'))
                                  THEN jsonb_set(
                                         model.value,
                                         '{tagline}',
                                         v_replacement -> (model.value ->> 'id')
                                       )
                                  ELSE model.value
                                END
                                ORDER BY model.ordinality
                              )
                       FROM jsonb_array_elements(tier.value -> 'models')
                            WITH ORDINALITY AS model(value, ordinality)
                     )
                   )
                   ORDER BY tier.ordinality
                 )
          FROM jsonb_array_elements(target.value -> 'tiers')
               WITH ORDINALITY AS tier(value, ordinality)
        )
      ),
      version = COALESCE(target.version, 0) + 1,
      updated_at = now()
  WHERE target.key = 'llm_model_catalog'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(target.value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      WHERE v_seeded ? (model ->> 'id')
        AND model ->> 'tagline' = (v_seeded ->> (model ->> 'id'))
    );
END;
$$;

COMMIT;

-- 新增 RPC 需要 PostgREST 重新加载 schema 才能被 supabase-js 调用。
NOTIFY pgrst, 'reload schema';
