-- 095_reconcile_managed_config_keys.sql
--
-- 收敛两条并行开发的 managed config key 迁移互相覆盖的问题：
--
--   092_payment_prompt_dialog_config.sql   -> miniapp_payment_prompt_dialog_config
--   093_lobby_pinned_characters_config.sql -> lobby_pinned_characters
--
-- 两条都按仓库惯例「重新声明整套白名单 + CREATE OR REPLACE 总入口」写的，而它们各自
-- 抄的是自己开工时的名单，互相不知道对方存在。于是谁后执行，谁就把对方的 key 从
-- 四处声明里整段抹掉：
--
--   admin.config_drafts   的 config_key CHECK   -> 决定草稿能不能落库
--   admin.config_releases 的 config_key CHECK   -> 决定发布记录能不能落库
--   admin.is_managed_config_key                 -> 决定 get_managed_configs 会不会返回给运营台
--   admin.validate_managed_config_value         -> 决定值本身走哪条校验分支
--
-- 症状是运营台菜单照常显示（菜单由前端常量 managedConfigKeys 渲染，不问库），但一点
-- 「保存草稿」就撞 CHECK 约束，表现为「存不进去」。测试库上先被 092 那侧覆盖过一次。
--
-- 本迁移把两个 key 在四处全部补齐，且不再重抄任何历史分支：总入口只显式拦这两个新
-- key，其余一律委托给 092 留下的 validate_managed_config_value_before_payment_prompt
-- 快照。少抄一段就等于删掉一个 key 的校验，所以这里刻意不抄。
--
-- 执行顺序：092 与 093_lobby_pinned 都落库之后再执行本条（依赖它们建出的三个函数，
-- 下面的前置检查会挡住顺序错误的情况）。
--
-- ⚠️ 给后来者：再加 managed config key 时，不要照抄仓库里上一版迁移的名单，先读一次
-- 目标库这四处的实际内容再写并集；否则两个人并行加 key 必然重演本次事故。

BEGIN;

-- ─── 前置检查：三个被委托的函数必须都在 ─────────────────────────────────────
-- plpgsql 函数体在创建时不校验里面引用的函数是否存在，漏了只会等到运营台点保存时
-- 才炸。这里提前失败，避免迁移「成功」但校验链是断的。
DO $$
BEGIN
  IF to_regprocedure('admin.validate_lobby_pinned_characters(jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_lobby_pinned_characters(jsonb)，请先执行 093_lobby_pinned_characters_config.sql';
  END IF;
  IF to_regprocedure('admin.validate_payment_prompt_dialog_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_payment_prompt_dialog_config(jsonb)，请先执行 092_payment_prompt_dialog_config.sql';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)，请先执行 092_payment_prompt_dialog_config.sql';
  END IF;
END;
$$;

-- ─── config_drafts / config_releases 的 CHECK ────────────────────────────────
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
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters'
  ));

-- ─── get_managed_configs 的可见性开关 ───────────────────────────────────────
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
    'lobby_pinned_characters'
  );
$$;

-- ─── 校验总入口：两个新 key 各一条分支，其余下沉 ────────────────────────────
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

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 执行后自检：断言不成立就让本次迁移失败回滚 ──────────────────────────────
-- 这块被并行迁移覆盖过两次，且症状（菜单能看见、保存才报错）不看库根本发现不了，
-- 所以把验证写成断言跟着迁移一起跑，而不是留在注释里等人去手点。
DO $$
DECLARE
  v_key    TEXT;
  v_def    TEXT;
  v_raised BOOLEAN;
BEGIN
  -- 1) 两个 key 都应对运营台可见
  FOREACH v_key IN ARRAY ARRAY['lobby_pinned_characters', 'miniapp_payment_prompt_dialog_config'] LOOP
    IF NOT admin.is_managed_config_key(v_key) THEN
      RAISE EXCEPTION '自检失败：is_managed_config_key(%) 返回 false', v_key;
    END IF;
  END LOOP;

  -- 2) 两张表的 CHECK 都应同时含这两个 key
  FOR v_def IN
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
      AND conname LIKE '%config_key_check'
  LOOP
    IF position('lobby_pinned_characters' IN v_def) = 0
       OR position('miniapp_payment_prompt_dialog_config' IN v_def) = 0 THEN
      RAISE EXCEPTION '自检失败：CHECK 约束缺少 key -> %', v_def;
    END IF;
  END LOOP;

  -- 3) 两条新分支都必须真的被走到。用 text_value 守卫探针：只有进了对应分支才会
  --    抛出这句特定文案，落到下游快照抛的会是别的消息，据此判断分支没被盖掉。
  FOREACH v_key IN ARRAY ARRAY['lobby_pinned_characters', 'miniapp_payment_prompt_dialog_config'] LOOP
    v_raised := FALSE;
    BEGIN
      PERFORM admin.validate_managed_config_value(v_key, '{}'::jsonb, 'probe');
    EXCEPTION WHEN OTHERS THEN
      v_raised := TRUE;
      IF position('must not use text_value' IN SQLERRM) = 0 THEN
        RAISE EXCEPTION '自检失败：% 没走到自己的分支，实际报错为 %', v_key, SQLERRM;
      END IF;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION '自检失败：% 的校验分支静默放过了非法输入', v_key;
    END IF;
  END LOOP;

  -- 4) 未受影响的老 key 仍应正常下沉到快照链
  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：校验链下沉断了，system_instructions 放过了空值';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT) IS
  'Managed config validation entry point. Handles lobby_pinned_characters and miniapp_payment_prompt_dialog_config, then defers to the pre-092 snapshot.';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证已内联为上面的自检断言：迁移跑通即代表四处声明齐、两条分支可达、下沉链未断，
-- 不需要另外手工查库。
--
-- 回滚：把四处名单里的 'lobby_pinned_characters' 去掉、总入口去掉对应分支后重新执行。
