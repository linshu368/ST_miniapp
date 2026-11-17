#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_managed_config_keys.sql against the production is_managed_config_key chain
# (scripts/sql/db-reorg-p1e/is-managed-chain-prod.sql). Everything runs as a NON-superuser with CREATEROLE,
# like Supabase's postgres. Checks: idempotent re-run; per-key result identical to the old chain except the
# 7 intentionally retired keys; NULL semantics kept; key CHECKs replaced by FKs that keep history (including a
# legacy key outside the old CHECK) and reject unknown keys; the 9 wrapper functions are gone; dead
# runtime_config rows deleted while live ones stay.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_managed_config_keys.sql"
chain="$task_root/scripts/sql/db-reorg-p1e/is-managed-chain-prod.sql"
task_container="st-db-reorg-p1e-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE SCHEMA admin; CREATE SCHEMA app_core;
SQL
"${admin_psql[@]}" >/dev/null < "$chain"
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE app_core.runtime_config(key text PRIMARY KEY, value jsonb);
INSERT INTO app_core.runtime_config(key, value) VALUES
  ('lobby_pinned_characters','{}'), ('miniapp_daily_checkin_bonus_credits','5'), ('ai_config_source','{}'),
  ('llm_model_tiers','[]'), ('miniapp_chat_message_credit_cost','1'), ('interaction_mode_blocks','{}'),
  ('miniapp_model_tier_credit_costs','{}'), ('media_feature_free_trial_limit','3'),
  ('miniapp_recharge_page_config','{}'), ('miniapp_payment_prompt_dialog_config','{}'),
  ('image_plaza_tags_feature_enabled','true'),
  ('llm_model_catalog','{}'), ('free_zone_config','{}'), ('voice_billing_enabled','true');
CREATE TABLE admin.config_drafts(id bigserial PRIMARY KEY, config_key text NOT NULL);
CREATE TABLE admin.config_releases(id bigserial PRIMARY KEY, config_key text NOT NULL);
-- A legacy row outside the current key set, as an older environment may hold (CHECK added NOT VALID later).
INSERT INTO admin.config_drafts(config_key) VALUES ('legacy_interaction_mode');
INSERT INTO admin.config_drafts(config_key) VALUES ('llm_model_catalog'), ('miniapp_text_postprocess_config'), ('lobby_pinned_characters');
INSERT INTO admin.config_releases(config_key) VALUES ('drive_mode_options'), ('miniapp_payment_prompt_dialog_config'), ('miniapp_daily_checkin_bonus_credits');
ALTER TABLE admin.config_drafts ADD CONSTRAINT config_drafts_config_key_check CHECK ((admin.is_managed_config_key_before_image_plaza(config_key) OR (config_key = 'miniapp_text_postprocess_config'::text) OR (config_key = ANY ('{image_plaza_enabled,image_plaza_model_catalog,image_plaza_share_tip,image_plaza_tags}'::text[])) OR (config_key = ANY ('{image_plaza_tags_feature_enabled}'::text[])) OR admin.is_managed_config_key_before_reply_styles(config_key) OR admin.is_managed_config_key_before_checkin_tiers(config_key) OR admin.is_managed_config_key_before_creator_review(config_key) OR admin.is_managed_config_key_before_story_memory(config_key) OR admin.is_managed_config_key_before_free_zone(config_key) OR admin.is_managed_config_key_before_drive_mode(config_key) OR admin.is_managed_config_key(config_key))) NOT VALID;
ALTER TABLE admin.config_releases ADD CONSTRAINT config_releases_config_key_check CHECK ((admin.is_managed_config_key_before_image_plaza(config_key) OR (config_key = 'miniapp_text_postprocess_config'::text) OR (config_key = ANY ('{image_plaza_enabled,image_plaza_model_catalog,image_plaza_share_tip,image_plaza_tags}'::text[])) OR (config_key = ANY ('{image_plaza_tags_feature_enabled}'::text[])) OR admin.is_managed_config_key_before_reply_styles(config_key) OR admin.is_managed_config_key_before_checkin_tiers(config_key) OR admin.is_managed_config_key_before_creator_review(config_key) OR admin.is_managed_config_key_before_story_memory(config_key) OR admin.is_managed_config_key_before_free_zone(config_key) OR admin.is_managed_config_key_before_drive_mode(config_key) OR admin.is_managed_config_key(config_key)));
ALTER TABLE admin.config_drafts ADD CONSTRAINT config_drafts_no_advanced_image_config CHECK (config_key <> ALL (ARRAY['image_advanced_enabled','image_advanced_generation_credits','image_advanced_price_label','image_advanced_provider_config']));
ALTER TABLE admin.config_releases ADD CONSTRAINT config_releases_no_advanced_image_config CHECK (config_key <> ALL (ARRAY['image_advanced_enabled','image_advanced_generation_credits','image_advanced_price_label','image_advanced_provider_config']));
-- Independent baseline of the old chain over every key it knows plus probes.
CREATE TABLE app_core.test_baseline AS
SELECT k, admin.is_managed_config_key(k) AS was FROM unnest(ARRAY[
  'drive_mode_options','free_zone_config','story_memory_config','story_memory_prompt','creator_character_review_prompt',
  'miniapp_checkin_new_user_credits','miniapp_checkin_veteran_credits','reply_style_options','image_plaza_enabled',
  'image_plaza_model_catalog','image_plaza_share_tip','image_plaza_tags','image_plaza_tags_feature_enabled',
  'miniapp_new_user_signup_bonus_credits','miniapp_daily_checkin_bonus_credits','miniapp_character_free_chat_quota_limit',
  'miniapp_payment_plans','miniapp_recharge_page_config','miniapp_payment_prompt_dialog_config',
  'miniapp_free_quota_exhausted_dialog_config','llm_model_catalog','llm_pricing_config','llm_provider_routing_config',
  'system_fallback_character_id','system_instructions','choice_rules','status_rules','memory_rules','pref_word_count_tiers',
  'lobby_ranking_params','lobby_pinned_characters','miniapp_invite_reward_rules','miniapp_invite_center_config',
  'miniapp_invite_entry_enabled','image_generation_enabled','image_generation_credits','image_price_label',
  'image_text_model_config','image_prompt_policy','image_default_art_style','image_description_system_prompt',
  'image_width','image_height','image_max_prompt_chars','image_max_output_bytes','image_prompt_over_limit_hint',
  'image_description_failed_hint','image_generation_failed_hint','image_failed_unknown_hint',
  'media_feature_free_trial_limit','vip_purchase_enabled','vip_reminders_enabled','vip_plans_config',
  'vip_text_discount_rate','vip_checkin_bonus_config','feature_free_trial_limits',
  'miniapp_text_postprocess_config','voice_billing_enabled','image_advanced_enabled','','unknown']) AS k;
SQL

"${admin_psql[@]}" >/dev/null < "$migration"
# Re-running must be a no-op rather than an error.
"${admin_psql[@]}" >/dev/null < "$migration"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
DO $chk$
DECLARE v_diff text;
BEGIN
  SELECT string_agg(k || ':' || coalesce(was::text,'null') || '->' || coalesce(admin.is_managed_config_key(k)::text,'null'), ', ')
    INTO v_diff FROM app_core.test_baseline
  WHERE admin.is_managed_config_key(k) IS DISTINCT FROM (CASE WHEN k IN ('miniapp_recharge_page_config',
      'miniapp_payment_prompt_dialog_config','system_fallback_character_id','miniapp_daily_checkin_bonus_credits',
      'media_feature_free_trial_limit','image_plaza_tags_feature_enabled','lobby_pinned_characters') THEN false ELSE was END);
  IF v_diff IS NOT NULL THEN RAISE EXCEPTION 'is_managed changed: %', v_diff; END IF;
  IF (SELECT count(*) FROM app_core.test_baseline WHERE was) <> 56 THEN RAISE EXCEPTION 'baseline should know 56 managed keys (43 base + 13 later)'; END IF;
  IF admin.is_managed_config_key(NULL) IS NOT NULL THEN RAISE EXCEPTION 'NULL semantics changed'; END IF;
  IF admin.is_managed_config_key('miniapp_text_postprocess_config') THEN RAISE EXCEPTION 'text postprocess became managed'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'is_managed_config_key_before_%') THEN RAISE EXCEPTION 'wrapper functions remain'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('config_drafts_config_key_check','config_releases_config_key_check',
      'config_drafts_no_advanced_image_config','config_releases_no_advanced_image_config')) THEN RAISE EXCEPTION 'old CHECKs remain'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('config_drafts_config_key_fkey','config_releases_config_key_fkey')) <> 2 THEN
    RAISE EXCEPTION 'FKs missing';
  END IF;
  IF (SELECT retired_at FROM admin.managed_config_keys WHERE config_key = 'legacy_interaction_mode') IS NULL THEN
    RAISE EXCEPTION 'legacy history key not backfilled as retired';
  END IF;
  IF EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key IN ('lobby_pinned_characters','ai_config_source','llm_model_tiers',
      'miniapp_chat_message_credit_cost','interaction_mode_blocks','miniapp_model_tier_credit_costs','media_feature_free_trial_limit',
      'miniapp_recharge_page_config','miniapp_payment_prompt_dialog_config','image_plaza_tags_feature_enabled',
      'miniapp_daily_checkin_bonus_credits')) THEN RAISE EXCEPTION 'dead runtime_config rows remain'; END IF;
  IF (SELECT count(*) FROM app_core.runtime_config WHERE key IN ('llm_model_catalog','free_zone_config','voice_billing_enabled')) <> 3 THEN
    RAISE EXCEPTION 'live runtime_config rows deleted';
  END IF;
  INSERT INTO admin.config_drafts(config_key) VALUES ('drive_mode_options');
  BEGIN
    INSERT INTO admin.config_drafts(config_key) VALUES ('not_a_key');
    RAISE EXCEPTION 'unknown key accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO admin.config_releases(config_key) VALUES ('image_advanced_enabled');
    RAISE EXCEPTION 'advanced key accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  IF has_function_privilege('authenticated', 'admin.is_managed_config_key(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'is_managed_config_key granted beyond owner';
  END IF;
END $chk$;
SQL
echo 'OK: 20261117_db_reorg_managed_config_keys.sql'
