-- 104_rollback_voice_billing.sql
--
-- 回滚 test 上已经执行的 101_voice_billing + 102_voice_pending_unique。
--
-- 查库结论（2026-08-28）：
--   test  (zoqelpfhurwehlvypryl)：101/102 已执行。099 之后对象在新 schema：
--     experience.chat_message_audio.credits_charged / charge_id
--     experience.uq_chat_message_audio_pending
--     experience.idx_chat_message_audio_session_all
--     experience.idx_chat_message_audio_charge
--     billing.charge_voice_usage
--     admin.validate_voice_config_value
--     app_core.runtime_config 七个 voice_* 键（voice_billing_enabled = true）
--     14 条 chat_message_audio 已扣费，对应 14 条 wallet_ledger.voice_usage
--   prod (wbtsfzozlmurljvglhpn)：101/102 从未执行。不要在 prod 跑本文件。
--
-- 执行顺序：
--   1. 合并 PR #298，把 test backend 部署到 revert 后的代码
--      （旧 createPending 插 is_active=true 的 pending，靠 uq_chat_message_audio_active
--       拦连点。若先丢 pending 唯一索引、代码还是 293，连点会插两条 inactive pending）
--   2. GitHub Actions → Database Migration → environment=test
--      migration_file=packages/shared/migrations/104_rollback_voice_billing.sql
--
-- 本文件不退 14 笔已扣星尘：wallet_ledger 里 reference_type='voice_usage' 的行保留。
-- 删列会丢掉这 14 行的 credits_charged / charge_id 对照，但不改余额。

BEGIN;

-- ─── 0. 前置：本库必须真有 101/102 产物，挡住误跑 prod ────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'charge_voice_usage'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_message_audio' AND column_name = 'credits_charged'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'uq_chat_message_audio_pending'
  ) THEN
    RAISE EXCEPTION
      '本库没有 101/102 产物，拒绝执行。prod 就是这种状态，不要在 prod 跑本文件';
  END IF;

  IF to_regprocedure('admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION
      '缺少 admin.validate_managed_config_value_before_payment_prompt，无法把校验总入口还原到 095';
  END IF;
END;
$$;

-- ─── 1. 回滚 102：pending 唯一索引 + 会话非部分索引 ────────────────────────
DROP INDEX IF EXISTS experience.uq_chat_message_audio_pending;
DROP INDEX IF EXISTS miniapp.uq_chat_message_audio_pending;
DROP INDEX IF EXISTS experience.idx_chat_message_audio_session_all;
DROP INDEX IF EXISTS miniapp.idx_chat_message_audio_session_all;

-- ─── 2. 回滚 101：managed-config 白名单还原到 095（去掉 7 个 voice_*，
--     保留 miniapp_payment_prompt_dialog_config；不要整段重跑 093，093 漏过这个 key）
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

-- 校验总入口先换成 095 版本（不再调用 validate_voice_config_value），再删语音校验函数。
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

DROP FUNCTION IF EXISTS admin.validate_voice_config_value(TEXT, JSONB);
DROP FUNCTION IF EXISTS billing.charge_voice_usage(UUID, UUID, UUID, NUMERIC, JSONB);
DROP FUNCTION IF EXISTS miniapp.charge_voice_usage(UUID, UUID, UUID, NUMERIC, JSONB);

-- ─── 3. 回滚 101：列、charge 索引、配置键、运营台草稿 ──────────────────────
DROP INDEX IF EXISTS experience.idx_chat_message_audio_charge;
DROP INDEX IF EXISTS miniapp.idx_chat_message_audio_charge;

DO $$
DECLARE
  audio_tbl regclass;
  runtime_tbl regclass;
BEGIN
  audio_tbl := COALESCE(
    to_regclass('experience.chat_message_audio'),
    to_regclass('miniapp.chat_message_audio')
  );
  IF audio_tbl IS NULL THEN
    RAISE EXCEPTION 'chat_message_audio not found in experience or miniapp';
  END IF;
  EXECUTE format(
    'ALTER TABLE %s DROP COLUMN IF EXISTS charge_id, DROP COLUMN IF EXISTS credits_charged',
    audio_tbl
  );

  runtime_tbl := COALESCE(
    to_regclass('app_core.runtime_config'),
    to_regclass('miniapp.runtime_config')
  );
  IF runtime_tbl IS NOT NULL THEN
    EXECUTE format('DELETE FROM %s WHERE key LIKE ''voice_%%''', runtime_tbl);
  END IF;
END;
$$;

DELETE FROM admin.config_drafts WHERE config_key LIKE 'voice_%';
DELETE FROM admin.config_releases WHERE config_key LIKE 'voice_%';

-- ─── 4. 自检 ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def TEXT;
  v_raised BOOLEAN;
BEGIN
  IF admin.is_managed_config_key('voice_billing_enabled') THEN
    RAISE EXCEPTION '自检失败：voice_billing_enabled 仍在白名单';
  END IF;
  IF NOT admin.is_managed_config_key('miniapp_payment_prompt_dialog_config') THEN
    RAISE EXCEPTION '自检失败：误把 miniapp_payment_prompt_dialog_config 从白名单抹掉';
  END IF;
  IF NOT admin.is_managed_config_key('lobby_pinned_characters') THEN
    RAISE EXCEPTION '自检失败：误把 lobby_pinned_characters 从白名单抹掉';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname IN ('charge_voice_usage', 'validate_voice_config_value')
  ) THEN
    RAISE EXCEPTION '自检失败：charge_voice_usage 或 validate_voice_config_value 还在';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_message_audio'
      AND column_name IN ('credits_charged', 'charge_id')
  ) THEN
    RAISE EXCEPTION '自检失败：chat_message_audio 计费列还在';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname IN (
      'uq_chat_message_audio_pending',
      'idx_chat_message_audio_session_all',
      'idx_chat_message_audio_charge'
    )
  ) THEN
    RAISE EXCEPTION '自检失败：101/102 索引还在';
  END IF;

  FOR v_def IN
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid IN ('admin.config_drafts'::regclass, 'admin.config_releases'::regclass)
      AND conname LIKE '%config_key_check'
  LOOP
    IF position('voice_billing_enabled' IN v_def) > 0 THEN
      RAISE EXCEPTION '自检失败：CHECK 仍含 voice_* -> %', v_def;
    END IF;
    IF position('miniapp_payment_prompt_dialog_config' IN v_def) = 0
       OR position('lobby_pinned_characters' IN v_def) = 0 THEN
      RAISE EXCEPTION '自检失败：CHECK 缺少既有 key -> %', v_def;
    END IF;
  END LOOP;

  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'lobby_pinned_characters', '{}'::jsonb, 'probe'
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
    IF position('must not use text_value' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION '自检失败：095 校验链没接上，实际报错为 %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION '自检失败：lobby_pinned_characters 校验分支静默放过了非法输入';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证：
--   SELECT admin.is_managed_config_key('voice_billing_enabled');              -- false
--   SELECT admin.is_managed_config_key('miniapp_payment_prompt_dialog_config'); -- true
--   SELECT to_regprocedure('billing.charge_voice_usage(uuid,uuid,uuid,numeric,jsonb)'); -- null
--   SELECT count(*) FROM billing.wallet_ledger WHERE reference_type = 'voice_usage';
--     -- 14；本文件故意不删、不退款
