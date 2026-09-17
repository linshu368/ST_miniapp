-- 20260914 rollback: 图片生成 attempt/任务/配置的结构回滚。
-- domain: experience + billing + app_core + admin
--
-- 仅在关闭 image_generation_enabled、停止图片 route/job，且确认没有已结算图片后执行。
-- 已有 image_generation ledger 时本文件会失败，避免删除审计事实。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM billing.wallet_ledger
    WHERE entry_type = 'image_generation'
       OR reference_type = 'image_generation'
  ) THEN
    RAISE EXCEPTION 'refuse rollback: image_generation ledger rows exist; use forward-fix instead';
  END IF;

  IF to_regclass('experience.chat_message_images') IS NOT NULL
     AND EXISTS (SELECT 1 FROM experience.chat_message_images) THEN
    RAISE EXCEPTION 'refuse rollback: image attempts exist; keep audit table and use forward-fix instead';
  END IF;

  IF EXISTS (
    SELECT 1 FROM admin.config_drafts WHERE config_key LIKE 'image_%'
  ) OR EXISTS (
    SELECT 1 FROM admin.config_releases WHERE config_key LIKE 'image_%'
  ) THEN
    RAISE EXCEPTION 'refuse rollback: image config drafts/releases exist; keep config history and use forward-fix instead';
  END IF;

  IF to_regprocedure('admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_lobby_pinned_characters(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_payment_prompt_dialog_config(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_invite_reward_rules(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_invite_center_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'managed config validators are incomplete; rollback would leave admin validation broken';
  END IF;
END;
$$;

DELETE FROM app_core.runtime_config
WHERE key IN (
  'image_generation_enabled',
  'image_generation_credits',
  'image_price_label',
  'image_default_art_style',
  'image_width',
  'image_height',
  'image_max_prompt_chars',
  'image_max_output_bytes',
  'image_prompt_policy',
  'image_prompt_over_limit_hint',
  'image_description_failed_hint',
  'image_generation_failed_hint',
  'image_failed_unknown_hint'
);

DROP FUNCTION IF EXISTS billing.settle_image_generation(UUID, UUID, NUMERIC, JSONB);
DROP FUNCTION IF EXISTS experience.claim_chat_image_jobs(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS experience.chat_message_images;
DROP INDEX IF EXISTS billing.uq_wallet_ledger_image_generation_reference;

ALTER TABLE billing.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN (
    'recharge', 'chat_debit', 'refund', 'adjustment',
    'checkin_bonus', 'wish_reward', 'invite_reward', 'community_reward'
  ));

DROP FUNCTION IF EXISTS admin.validate_image_generation_config_value(TEXT, JSONB);

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
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
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
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
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
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled'
  );
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

  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_reward_rules must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_center_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_center_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a boolean'
        USING ERRCODE = '22023';
    END IF;
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

DO $$
BEGIN
  IF admin.is_managed_config_key('image_generation_enabled') THEN
    RAISE EXCEPTION 'rollback self-check failed: image_generation_enabled still managed';
  END IF;
  IF to_regclass('experience.chat_message_images') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback self-check failed: chat_message_images still exists';
  END IF;
  IF to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback self-check failed: settle_image_generation still exists';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
