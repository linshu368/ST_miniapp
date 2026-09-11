#!/usr/bin/env node
/**
 * 迁移文件命名守门人。
 *
 * 背景：三位数字编号在并行分支上撞号是惯犯（021/030/031/032/053/065/086/088/092/093/095
 * 历史撞号，100 号立「全分支唯一」规矩后 105/108/109 又各撞一对）。2026-09-10 起新迁移
 * 一律用 YYYYMMDD_描述.sql（日期戳 + 语义名），并行分支天然不撞号；配套账本表
 * supabase_migrations.repo_migrations 记录每个环境实际执行过哪些文件（见 db-migrate.yml）。
 *
 * 规则：
 *   1. 存量旧编号文件在下方 FROZEN_LEGACY_FILES 清单里锁死——新增任何三位数字编号
 *      文件（不在清单内）即报错；
 *   2. 新文件必须匹配 /^20\d{6}_[a-z0-9_]+\.sql$/；
 *   3. archive/ 子目录是留档，不扫。
 *
 * 本地跑：pnpm lint:migrations
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const migrationsDir = join(repoRoot, 'packages', 'shared', 'migrations');

/**
 * 2026-09-10 定格的存量迁移清单。这些文件已在各环境执行过，按定义就是留档：
 * 不改名、不新增同风格文件。若你在改这个清单，请先确认自己不是在开历史倒车。
 */
const FROZEN_LEGACY_FILES = new Set([
  '001_users_add_st_fields.sql',
  '002_users_backfill_st_handle.sql',
  '003_create_st_schemas.sql',
  '004_characters_add_sync_fields.sql',
  '005_platform_settings.sql',
  '006_platform_presets.sql',
  '007_platform_api_configs.sql',
  '008_user_st_settings.sql',
  '009_user_st_chats.sql',
  '010_rls_policies.sql',
  '011_seed_data.sql',
  '012_sync_tasks.sql',
  '013_migrate_st_schema_split.sql',
  '014_miniapp_payment_wallet.sql',
  '015_miniapp_settings_wallet_ops.sql',
  '016_miniapp_wallet_ledger_chat_idempotency.sql',
  '017_miniapp_wallet_payment_summary.sql',
  '018_miniapp_free_chat_idempotency.sql',
  '019_miniapp_billing_checkin.sql',
  '020_drop_legacy_app_chat_tables.sql',
  '021_character_field_cleanup.sql',
  '021_miniapp_wish_roles.sql',
  '022_characters_raw_card_beijing_time.sql',
  '023_move_wishes_to_miniapp.sql',
  '024_cs_platform.sql',
  '025_preset_auto_promote.sql',
  '026_chat_history_log.sql',
  '027_cs_persona_sql_normalization.sql',
  '028_miniapp_users.sql',
  '029_growth_attribution.sql',
  '030_chat_history_interaction_round.sql',
  '030_user_avatar_sources.sql',
  '031_chat_history_llm_metadata.sql',
  '031_signup_and_checkin_rewards.sql',
  '032_daily_checkin_reward_40.sql',
  '032_llm_dynamic_pricing.sql',
  '033_lock_preset_fields.sql',
  '034_signup_bonus_398.sql',
  '035_admin_config_management.sql',
  '036_admin_operator_names.sql',
  '037_model_selector_complete.sql',
  '038_seed_payment_plans.sql',
  '039_admin_character_cards.sql',
  '040_migrate_llm_model_catalog.sql',
  '041_admin_operations_features.sql',
  '042_admin_config_validation_and_audit_compaction.sql',
  '043_admin_analytics.sql',
  '044_admin_platform_presets.sql',
  '045_admin_character_layout_drafts.sql',
  '046_admin_character_layout_rollback.sql',
  '047_admin_character_layout_release_details.sql',
  '048_admin_create_character.sql',
  '049_admin_delete_character_layout_release.sql',
  '050_llm_spending_details.sql',
  '051_llm_deferred_billing.sql',
  '053_llm_spending_retention.sql',
  '053_platform_preset_model_assignments.sql',
  '054_default_user_avatar_asset.sql',
  '055_character_free_chat_quota.sql',
  '056_character_favorites_and_model_tagline.sql',
  '057_free_quota_exhausted_dialog_config.sql',
  '058_fixed_tier_llm_billing.sql',
  '059_model_catalog_cost_hint_limit.sql',
  '060_lobby_recommended_latest_sorting.sql',
  '061_character_free_chat_quota_limit_config.sql',
  '062_simulation_card_evaluation.sql',
  '063_admin_layout_exclude_test_cards.sql',
  '064_message_center_and_support.sql',
  '065_light_fixed_deduction.sql',
  '065_support_user_read_state.sql',
  '066_admin_outreach_credit_grant.sql',
  '067_lobby_latest_seen_state.sql',
  '068_model_preset_directory_admin.sql',
  '069_miniapp_chat_sessions.sql',
  '070_chat_session_rpc.sql',
  '071_engine_platform_instructions.sql',
  '072_chat_history_conversation_source.sql',
  '073_current_chat_history_view.sql',
  '074_lobby_ranking_score_v3.sql',
  '075_chat_engine_mode.sql',
  '076_engine_admin_platform_instructions.sql',
  '077_context_window.sql',
  '078_chat_session_pinned.sql',
  '079_chat_session_title_default_character_name.sql',
  '080_chat_message_voice.sql',
  '081_finish_reason_billing_gate.sql',
  '082_spending_reply_outcomes.sql',
  '083_drop_chat_engine_mode.sql',
  '084_remove_legacy_llm_display_fields.sql',
  '085_llm_free_flag_and_drop_pricing_markup.sql',
  '086_miniapp_wish_roles_repair.sql',
  '086_pref_word_count_unset.sql',
  '087_drop_dead_admin_rpcs.sql',
  '088_drop_st_schemas.sql',
  '088_lobby_ranking_params_config.sql',
  '089_drop_growth.sql',
  '090_drop_miniapp_simulation.sql',
  '091_drop_chat_message_charges.sql',
  '092_free_quota_exhausted_notice_text.sql',
  '092_payment_prompt_dialog_config.sql',
  '093_lobby_pinned_characters_config.sql',
  '093_payment_prompt_dialog_footer_note.sql',
  '094_cs_outreach_efficiency.sql',
  '095_reconcile_managed_config_keys.sql',
  '095_revert_free_quota_exhausted_notice_text.sql',
  '096_reapply_free_quota_exhausted_notice_text.sql',
  '097_chat_history_drop_dead_columns.sql',
  '098_characters_drop_st_sync_columns.sql',
  '099_schema_split_phase1.sql',
  '099_schema_split_phase1_rollback.sql',
  '100_payment_reconciliation_schedule.sql',
  '103_payment_settled_by.sql',
  '104_rollback_voice_billing.sql',
  '105_invite_program.sql',
  '105_voice_billing_atomic.sql',
  '106_invite_admin_query.sql',
  '107_invite_poster_bucket.sql',
  '108_invite_chat_round_reward.sql',
  '108_official_community_reward.sql',
  '109_community_existing_member_reward.sql',
  '109_invite_first_paid_reward.sql',
  '110_characters_add_persona_and_style.sql',
  '111_users_st_handle_drop_not_null.sql',
  '112_users_drop_st_handle.sql',
]);

/** 新迁移命名：YYYYMMDD_小写下划线描述.sql */
const NEW_NAME_PATTERN = /^20\d{6}_[a-z0-9_]+\.sql$/;

const errors = [];

const entries = readdirSync(migrationsDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) continue; // archive/ 留档不扫
  if (!entry.name.endsWith('.sql')) continue;

  if (FROZEN_LEGACY_FILES.has(entry.name)) continue;

  if (!NEW_NAME_PATTERN.test(entry.name)) {
    if (/^\d{3}_/.test(entry.name)) {
      errors.push(
        `${entry.name}: 三位数字编号已于 2026-09-10 停用（并行分支撞号是惯犯）。` +
          `请改用 YYYYMMDD_描述.sql，例如 20260910_${entry.name.replace(/^\d+_/, '')}`
      );
    } else {
      errors.push(`${entry.name}: 不符合新迁移命名规范 YYYYMMDD_描述.sql（小写字母/数字/下划线）`);
    }
  }
}

if (errors.length > 0) {
  console.error('迁移文件命名检查未通过：\n');
  for (const message of errors) {
    console.error(`  ✗ ${message}`);
  }
  console.error('\n规则说明见 packages/shared/migrations/README.md「文件命名规范」。');
  process.exit(1);
}

console.log('迁移文件命名检查通过。');
