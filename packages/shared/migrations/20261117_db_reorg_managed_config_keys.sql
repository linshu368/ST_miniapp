-- Domain: admin（运营平台托管配置的 key 登记）+ app_core.runtime_config（删除无人读取的 key）。
-- 数据库重组阶段 1e，规则见 docs/db/CONTRACT.md §2.4/§2.5，计划见 .trellis/tasks/11-17-db-reorg-p1-foundation/design.md。
--
-- 背景：每加一个托管 key，旧做法是把 admin.is_managed_config_key 改名为 *_before_<feature> 再包一层（已 9 层），
-- 同时删除重建 config_drafts / config_releases 上拼接 key 列表的 CHECK。本迁移改为：
--   1) admin.managed_config_keys 登记表：一行一个 key；managed_via 区分运营配置与文本后处理；
--      retired_at 非空表示已退役（不再可编辑，但发布历史仍引用，所以保留行）。
--   2) is_managed_config_key 改为查表（NULL 入参仍返回 NULL，与原函数一致）。迁移内先记录旧链对每个已知 key
--      及若干非 key 的判断，替换后逐一比对；除本次有意退役的 7 个 key 外有任何不一致即整体回滚。
--   3) 两张表的 key CHECK 改为外键引用登记表；删除冗余的 *_no_advanced_image_config CHECK（这些 key 不在登记表）。
--   4) 删除 9 个 is_managed_config_key_before_* 函数。
--   5) 退役 7 个 key：运营台早已不展示（packages/admin/src/lib/configSchemas.test.ts 'retired configs'），
--      后端与函数不再读取；同时删除这 7 个及另外 5 个零引用 key 在 runtime_config 的行。
--   validate_managed_config_value 的 15 层链本次不改（含入参改写与后置校验，等价重写成本高），
--   冻结：新 key 只在最外层函数原地 CREATE OR REPLACE 加分支；阶段 3 合并配置对象时整体重写。
--
-- Verify: bash scripts/test-db-reorg-p1e-migration.sh（PG17 非超级用户执行：两次幂等、旧链与登记表判断逐 key 一致、
--   外键接受历史 key 拒绝未知 key、退役 key 不可再发布、NULL 语义不变）。
-- Release: TEST -> Production -> admin/shared 去掉两个已无引用的常量（先后不敏感）。
-- Note: 外键检查以表所有者身份执行；登记表不对任何应用角色授权。
-- Recovery: 登记表与外键可保留；需要恢复某个退役 key 时 UPDATE retired_at = NULL 并重新写回 runtime_config 行。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS admin.managed_config_keys (
  config_key text CONSTRAINT managed_config_keys_pkey PRIMARY KEY
    CONSTRAINT managed_config_keys_key_format CHECK (config_key ~ '^[a-z][a-z0-9_]*$'),
  managed_via text NOT NULL DEFAULT 'operations_config'
    CONSTRAINT managed_config_keys_managed_via_check CHECK (managed_via IN ('operations_config', 'text_postprocess')),
  retired_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE admin.managed_config_keys IS
  '运营平台可写入 config_drafts/config_releases 的 key 登记。加 key = 插一行（并在 validate_managed_config_value 最外层加校验分支、admin-client 注册）；不再改名套函数、不再重建 CHECK。retired_at 非空表示退役：不可再编辑，历史发布仍引用。';
COMMENT ON COLUMN admin.managed_config_keys.managed_via IS
  'operations_config：通用配置草稿/发布（is_managed_config_key 为真）；text_postprocess：走文本后处理专用流程，只允许出现在草稿/发布表。';
ALTER TABLE admin.managed_config_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin.managed_config_keys FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO admin.managed_config_keys (config_key, managed_via) VALUES
  -- 006 起的基础托管 key（原 is_managed_config_key_before_image_plaza）
  ('miniapp_new_user_signup_bonus_credits', 'operations_config'),
  ('miniapp_daily_checkin_bonus_credits', 'operations_config'),
  ('miniapp_character_free_chat_quota_limit', 'operations_config'),
  ('miniapp_payment_plans', 'operations_config'),
  ('miniapp_recharge_page_config', 'operations_config'),
  ('miniapp_payment_prompt_dialog_config', 'operations_config'),
  ('miniapp_free_quota_exhausted_dialog_config', 'operations_config'),
  ('llm_model_catalog', 'operations_config'),
  ('llm_pricing_config', 'operations_config'),
  ('llm_provider_routing_config', 'operations_config'),
  ('system_fallback_character_id', 'operations_config'),
  ('system_instructions', 'operations_config'),
  ('choice_rules', 'operations_config'),
  ('status_rules', 'operations_config'),
  ('memory_rules', 'operations_config'),
  ('pref_word_count_tiers', 'operations_config'),
  ('lobby_ranking_params', 'operations_config'),
  ('lobby_pinned_characters', 'operations_config'),
  ('miniapp_invite_reward_rules', 'operations_config'),
  ('miniapp_invite_center_config', 'operations_config'),
  ('miniapp_invite_entry_enabled', 'operations_config'),
  ('image_generation_enabled', 'operations_config'),
  ('image_generation_credits', 'operations_config'),
  ('image_price_label', 'operations_config'),
  ('image_text_model_config', 'operations_config'),
  ('image_prompt_policy', 'operations_config'),
  ('image_default_art_style', 'operations_config'),
  ('image_description_system_prompt', 'operations_config'),
  ('image_width', 'operations_config'),
  ('image_height', 'operations_config'),
  ('image_max_prompt_chars', 'operations_config'),
  ('image_max_output_bytes', 'operations_config'),
  ('image_prompt_over_limit_hint', 'operations_config'),
  ('image_description_failed_hint', 'operations_config'),
  ('image_generation_failed_hint', 'operations_config'),
  ('image_failed_unknown_hint', 'operations_config'),
  ('media_feature_free_trial_limit', 'operations_config'),
  ('vip_purchase_enabled', 'operations_config'),
  ('vip_reminders_enabled', 'operations_config'),
  ('vip_plans_config', 'operations_config'),
  ('vip_text_discount_rate', 'operations_config'),
  ('vip_checkin_bonus_config', 'operations_config'),
  ('feature_free_trial_limits', 'operations_config'),
  -- 之后各层包装函数加入的 key
  ('image_plaza_enabled', 'operations_config'),
  ('image_plaza_model_catalog', 'operations_config'),
  ('image_plaza_share_tip', 'operations_config'),
  ('image_plaza_tags', 'operations_config'),
  ('image_plaza_tags_feature_enabled', 'operations_config'),
  ('reply_style_options', 'operations_config'),
  ('miniapp_checkin_new_user_credits', 'operations_config'),
  ('miniapp_checkin_veteran_credits', 'operations_config'),
  ('creator_character_review_prompt', 'operations_config'),
  ('story_memory_config', 'operations_config'),
  ('story_memory_prompt', 'operations_config'),
  ('free_zone_config', 'operations_config'),
  ('drive_mode_options', 'operations_config'),
  -- 文本后处理走专用流程，只出现在草稿/发布表
  ('miniapp_text_postprocess_config', 'text_postprocess')
ON CONFLICT (config_key) DO NOTHING;

-- 2) 用旧链做基准，替换后逐 key 比对。重跑时旧链已删，跳过比对。
DO $swap$
DECLARE
  v_chain_present boolean := to_regprocedure('admin.is_managed_config_key_before_drive_mode(text)') IS NOT NULL;
  v_retired text[] := ARRAY['miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config',
    'system_fallback_character_id', 'miniapp_daily_checkin_bonus_credits', 'media_feature_free_trial_limit',
    'image_plaza_tags_feature_enabled', 'lobby_pinned_characters'];
  v_diff text;
BEGIN
  IF v_chain_present THEN
    CREATE TEMP TABLE managed_key_baseline ON COMMIT DROP AS
    SELECT k AS config_key, admin.is_managed_config_key(k) AS was_managed
    FROM unnest((SELECT array_agg(config_key) FROM admin.managed_config_keys)
                || ARRAY['', 'unknown_key', 'image_advanced_enabled', 'miniapp_official_community_url',
                         'voice_billing_enabled', 'DRIVE_MODE_OPTIONS']) AS k;
    -- 登记表必须覆盖旧链认可的全部 key
    SELECT string_agg(config_key, ', ') INTO v_diff FROM managed_key_baseline b
    WHERE b.was_managed AND NOT EXISTS (SELECT 1 FROM admin.managed_config_keys m WHERE m.config_key = b.config_key);
    IF v_diff IS NOT NULL THEN RAISE EXCEPTION 'registry misses managed keys: %', v_diff; END IF;
  END IF;

  UPDATE admin.managed_config_keys
     SET retired_at = COALESCE(retired_at, now()),
         note = COALESCE(note, '运营台不再展示、后端不再读取（20261117 退役）')
   WHERE config_key = ANY (v_retired);

  CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog
  AS $fn$
    SELECT CASE WHEN p_config_key IS NULL THEN NULL ELSE EXISTS (
      SELECT 1 FROM admin.managed_config_keys m
      WHERE m.config_key = p_config_key AND m.managed_via = 'operations_config' AND m.retired_at IS NULL
    ) END
  $fn$;
  COMMENT ON FUNCTION admin.is_managed_config_key(text) IS
    '是否为可编辑的运营托管 key：查 admin.managed_config_keys（operations_config 且未退役）。NULL 入参返回 NULL。';

  IF v_chain_present THEN
    SELECT string_agg(b.config_key || '=' || coalesce(b.was_managed::text, 'null') || '->'
                      || coalesce(admin.is_managed_config_key(b.config_key)::text, 'null'), ', ') INTO v_diff
    FROM managed_key_baseline b
    WHERE admin.is_managed_config_key(b.config_key) IS DISTINCT FROM
          (CASE WHEN b.config_key = ANY (v_retired) THEN false ELSE b.was_managed END);
    IF v_diff IS NOT NULL THEN RAISE EXCEPTION 'is_managed_config_key changed for: %', v_diff; END IF;
    IF admin.is_managed_config_key(NULL) IS NOT NULL THEN RAISE EXCEPTION 'NULL semantics changed'; END IF;
  END IF;
END $swap$;

-- 与原函数相同：只有 postgres 可执行；调用方均为 postgres 所有的 SECURITY DEFINER 函数。
REVOKE ALL ON FUNCTION admin.is_managed_config_key(text) FROM PUBLIC;

-- 3) CHECK -> 外键。环境间历史可能不同：草稿/发布表里登记表之外的 key 以退役身份补登，保证外键可建。
INSERT INTO admin.managed_config_keys (config_key, managed_via, retired_at, note)
SELECT DISTINCT k.config_key, 'operations_config', now(), '草稿/发布历史中出现的旧 key（20261117 补登，退役）'
FROM (SELECT config_key FROM admin.config_drafts UNION SELECT config_key FROM admin.config_releases) k
WHERE NOT EXISTS (SELECT 1 FROM admin.managed_config_keys m WHERE m.config_key = k.config_key)
ON CONFLICT (config_key) DO NOTHING;
ALTER TABLE admin.config_drafts DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts DROP CONSTRAINT IF EXISTS config_drafts_no_advanced_image_config;
ALTER TABLE admin.config_releases DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases DROP CONSTRAINT IF EXISTS config_releases_no_advanced_image_config;
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'config_drafts_config_key_fkey') THEN
    ALTER TABLE admin.config_drafts ADD CONSTRAINT config_drafts_config_key_fkey
      FOREIGN KEY (config_key) REFERENCES admin.managed_config_keys(config_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'config_releases_config_key_fkey') THEN
    ALTER TABLE admin.config_releases ADD CONSTRAINT config_releases_config_key_fkey
      FOREIGN KEY (config_key) REFERENCES admin.managed_config_keys(config_key);
  END IF;
END $fk$;

-- 4) 删除 9 层包装函数（此前确认只有链自身与上面两个 CHECK 引用它们）
DO $drop$
DECLARE
  v_ref text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosrc LIKE '%is_managed_config_key_before_%' AND p.proname NOT LIKE 'is_managed_config_key_before_%';
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'still referenced by: %', v_ref; END IF;
END $drop$;
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_drive_mode(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_free_zone(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_story_memory(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_creator_review(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_checkin_tiers(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_reply_styles(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_image_plaza_recovery(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_image_plaza_tags_feature(text);
DROP FUNCTION IF EXISTS admin.is_managed_config_key_before_image_plaza(text);

-- 5) 删除无人读取的运行配置行
DELETE FROM app_core.runtime_config
WHERE key IN (
  -- 本次退役的托管 key
  'miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config', 'system_fallback_character_id',
  'miniapp_daily_checkin_bonus_credits', 'media_feature_free_trial_limit', 'image_plaza_tags_feature_enabled',
  'lobby_pinned_characters',
  -- 非托管、代码与函数零引用
  'ai_config_source', 'interaction_mode_blocks', 'llm_model_tiers', 'miniapp_chat_message_credit_cost',
  'miniapp_model_tier_credit_costs'
);

COMMIT;
