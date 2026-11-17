-- Production bodies of the admin.is_managed_config_key chain as of 2026-11-17 (md5-verified against
-- wbtsfzozlmurljvglhpn, CRLF normalized). Fixture for scripts/test-db-reorg-p1e-migration.sh only.
CREATE FUNCTION admin.is_managed_config_key_before_image_plaza(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
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
CREATE FUNCTION admin.is_managed_config_key_before_image_plaza_tags_feature(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT p_config_key IN ('image_plaza_enabled', 'image_plaza_model_catalog',
    'image_plaza_share_tip', 'image_plaza_tags')
    OR admin.is_managed_config_key_before_image_plaza(p_config_key)
$fn$;
CREATE FUNCTION admin.is_managed_config_key_before_image_plaza_recovery(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT p_config_key = 'image_plaza_tags_feature_enabled'
    OR admin.is_managed_config_key_before_image_plaza_tags_feature(p_config_key)
$fn$;
CREATE FUNCTION admin.is_managed_config_key_before_reply_styles(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT p_config_key IN (
    'image_plaza_enabled', 'image_plaza_model_catalog',
    'image_plaza_share_tip', 'image_plaza_tags'
  ) OR admin.is_managed_config_key_before_image_plaza_recovery(p_config_key)
$fn$;
CREATE FUNCTION admin.is_managed_config_key_before_checkin_tiers(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
        SELECT p_config_key = 'reply_style_options'
          OR admin.is_managed_config_key_before_reply_styles(p_config_key)
      $fn$;
CREATE FUNCTION admin.is_managed_config_key_before_creator_review(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT p_config_key IN (
    'miniapp_checkin_new_user_credits',
    'miniapp_checkin_veteran_credits'
  ) OR admin.is_managed_config_key_before_checkin_tiers(p_config_key)
$fn$;
CREATE FUNCTION admin.is_managed_config_key_before_story_memory(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
     SELECT p_config_key='creator_character_review_prompt'
       OR admin.is_managed_config_key_before_creator_review(p_config_key)
   $fn$;
CREATE FUNCTION admin.is_managed_config_key_before_free_zone(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT p_config_key IN ('story_memory_config', 'story_memory_prompt')
        OR admin.is_managed_config_key_before_story_memory(p_config_key)
    $fn$;
CREATE FUNCTION admin.is_managed_config_key_before_drive_mode(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT p_config_key = 'free_zone_config'
        OR admin.is_managed_config_key_before_free_zone(p_config_key)
    $fn$;
CREATE FUNCTION admin.is_managed_config_key(p_config_key text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
      SELECT p_config_key = 'drive_mode_options'
        OR admin.is_managed_config_key_before_drive_mode(p_config_key)
    $fn$;
