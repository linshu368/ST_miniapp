-- domain: app_core / admin
-- Adds the three independently publishable instruction-slot configs.  The
-- legacy interaction_mode_blocks row is intentionally neither read nor changed:
-- an application rollback can still use it.
--
-- Release order: apply this single file in TEST, deploy the consumers, verify
-- draft/publish/history/rollback in TEST, then separately preflight/apply the
-- same file in Production.  This migration does not apply itself remotely.
--
-- Recovery: retain rows and releases.  Correct a bad validator or seed with a
-- reviewed forward migration or a new Admin release; do not rewrite history.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('admin.is_managed_config_key(text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL
     OR to_regprocedure('admin.validate_managed_config_value_before_rich_reply_protocol(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'platform instruction slots: managed-config validator chain is missing';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_instruction_slots(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'platform instruction slots: validator predecessor already exists';
  END IF;
END
$preflight$;

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_instruction_slots;

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits', 'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit', 'miniapp_payment_plans',
    'miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config', 'llm_model_catalog', 'llm_pricing_config',
    'llm_provider_routing_config', 'system_fallback_character_id', 'system_instructions',
    'choice_rules', 'status_rules', 'memory_rules', 'pref_word_count_tiers',
    'lobby_ranking_params', 'lobby_pinned_characters', 'miniapp_invite_reward_rules',
    'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_text_model_config', 'image_prompt_policy', 'image_default_art_style',
    'image_description_system_prompt', 'image_width', 'image_height',
    'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint',
    'media_feature_free_trial_limit', 'vip_purchase_enabled', 'vip_reminders_enabled',
    'vip_plans_config', 'vip_text_discount_rate', 'vip_checkin_bonus_config',
    'feature_free_trial_limits'
  );
$fn$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $fn$
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
$fn$;

-- Existing constraints are an explicit defense-in-depth allowlist in addition
-- to the RPC validator. `miniapp_text_postprocess_config` is deliberately
-- outside the generic allowlist: its immutable version pointer and history are
-- owned by dedicated text-postprocess RPCs, but existing drafts/releases must
-- remain valid. Keep interaction_mode_blocks outside both paths.
ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check,
  ADD CONSTRAINT config_drafts_config_key_check CHECK (
    admin.is_managed_config_key(config_key)
    OR config_key = 'miniapp_text_postprocess_config'
  );
ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check,
  ADD CONSTRAINT config_releases_config_key_check CHECK (
    admin.is_managed_config_key(config_key)
    OR config_key = 'miniapp_text_postprocess_config'
  );

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at)
VALUES
  ('choice_rules', jsonb_build_object(
    'on_first_two_turns', '本轮需要输出选项。正文结束后另起三行，每行使用一组小写且完整闭合的 [choice]...[/choice]；选项只提供下一步输入建议，不替用户决定行动，也不预演选择结果。',
    'on_later_turns', '在正文后输出三条可选的下一步输入建议；每条使用一组完整的小写 [choice]...[/choice]，不替用户作决定。',
    'off', '本轮不输出选项，不得输出 [choice]、[/choice]、选项标题或占位内容。'
  ), '平台规则槽位：选项三阶段文案。由 Admin 草稿/发布链独立管理。', 1, now()),
  ('status_rules', jsonb_build_object(
    'on_first_two_turns', '本轮需要输出状态栏。正文之后（选项开启时位于选项之后、记忆开启时位于记忆之前）只输出一组小写 [status]...[/status]。内部用一个或多个并列 <details><summary>面板名称</summary> 和 markdown 代码块；仅记录本轮结束时值得持续追踪的状态，不要空面板或复述剧情。',
    'on_later_turns', '在正确输出顺序中输出一组完整的小写 [status]...[/status]，用并列 details 面板简洁记录当前可持续追踪状态。',
    'off', '本轮不输出状态栏，不得输出 [status]、[/status]、状态栏标题或占位内容。'
  ), '平台规则槽位：状态栏三阶段文案。由 Admin 草稿/发布链独立管理。', 1, now()),
  ('memory_rules', jsonb_build_object(
    'on_first_two_turns', '本轮需要在整条回复最后输出一组小写 [memory]...[/memory]。内部以工作记忆、历史档案、里程碑三个 details 折叠区记录已发生事实；保持时间线连续，历史档案与既有里程碑不得擅自改写；[/memory] 后不得追加任何文字。',
    'on_later_turns', '在整条回复最后输出一组完整的小写 [memory]...[/memory]，简洁更新工作记忆、历史档案和里程碑中的已发生事实；结束标签后不得追加文字。',
    'off', '本轮不输出记忆区，不得输出 [memory]、[/memory]、记忆标题或占位内容。'
  ), '平台规则槽位：记忆区三阶段文案。由 Admin 草稿/发布链独立管理。', 1, now())
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_instruction_slots(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $selfcheck$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  IF NOT admin.is_managed_config_key('choice_rules')
     OR NOT admin.is_managed_config_key('status_rules')
     OR NOT admin.is_managed_config_key('memory_rules')
     OR admin.is_managed_config_key('interaction_mode_blocks') THEN
    RAISE EXCEPTION 'platform instruction slots: managed-key allowlist self-check failed';
  END IF;
  PERFORM admin.validate_managed_config_value(
    'choice_rules',
    '{"on_first_two_turns":"full","on_later_turns":"concise","off":"off"}'::jsonb,
    NULL
  );
  BEGIN
    PERFORM admin.validate_managed_config_value('choice_rules', '{"off":"x"}'::jsonb, NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'platform instruction slots: partial slot config was accepted'; END IF;

  v_rejected := false;
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'system_instructions', NULL,
      '{{INTERACTION_MODE}} {{WORD_COUNT}} {{USER_CUSTOM_INSTRUCTIONS}}'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'platform instruction slots: obsolete placeholder substituted for slot placeholders'; END IF;
END
$selfcheck$;

COMMIT;
NOTIFY pgrst, 'reload schema';
