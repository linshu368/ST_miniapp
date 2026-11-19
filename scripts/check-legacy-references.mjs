#!/usr/bin/env node
/**
 * 禁止旧链路与旧 schema 的新引用。
 *
 * 这是「一个关键行为只能有一条主路径」的守门人：历史上 ST 退场、schema 拆八域、
 * growth 下线、支付方案变更都留下过并行链路，靠人 review 记不住哪条已经死了。
 * 每条规则都对应一个已经收口完成的决定，命中即说明有人又开了第二条。
 *
 * 只扫活代码（packages/<pkg>/src、scripts）。历史迁移 SQL、docs、
 * ops 快照按定义就是留档，不在扫描范围内——改已执行过的迁移比留着它更危险。
 * 例外：packages/shared/migrations 下 2026-09-10 起的日期命名新迁移（YYYYMMDD_*.sql）
 * 会被扫——它们在 PR 阶段还没执行，正是拦「新迁移又开一条旧链路」的时机。
 *
 * 本地跑：pnpm lint:legacy
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

/** 活代码根目录。migrations / docs / ops 快照刻意不在内。 */
const SCAN_ROOTS = ['packages', 'scripts'];

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sql', '.toml'];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'generated',
]);

/** migrations 目录只扫日期命名的新迁移；三位编号存量是留档（见 check-migration-filenames.mjs）。 */
const NEW_MIGRATION_PATTERN = /^20\d{6}_[a-z0-9_]+\.sql$/;

/**
 * allow 里的路径是该规则的唯一合法归属地——也就是「这条主路径本人」。
 * 新增 allow 等于宣布又多了一个出口，改这里必须在 PR 里说明理由。
 */
const RULES = [
  // ── 旧 schema：099 拆域后 miniapp 只剩空壳，批次 D 待删 ──────────────────
  {
    id: 'miniapp-schema-client',
    pattern: /(?:\.schema\(|getDomainDb\()\s*['"]miniapp['"]/g,
    message: "miniapp schema 已是空壳。按域取客户端：getDomainDb('app_core' | 'experience' | ...)",
  },
  {
    id: 'miniapp-schema-sql',
    pattern: /\b(?:from|join|into|update|table)\s+miniapp\.\w+/gi,
    message: 'miniapp.* 表已迁往八个归属域，用新域的全限定名（见 docs/ARCHITECTURE.md §5.1）',
  },
  {
    id: 'dropped-schema-sql',
    pattern:
      /\b(?:from|join|into|update|table)\s+(?:st_platform|st_users|st_infra|miniapp_simulation|growth|cs_platform)\.\w+/gi,
    message:
      'st_platform / st_users / st_infra（088）、growth（089）、miniapp_simulation（090）、cs_platform（20261117）已删库。渠道归因走 miniapp_traffic，客服在独立仓库的 cs schema',
  },

  {
    id: 'moved-to-ops-sql',
    pattern:
      /\b(?:from|join|into|update|table)\s+(?:app_core\.alert_incidents|app_core\.alert_delivery_attempts|miniapp_features\.free_zone_events)\b/gi,
    message:
      '数据库重组 2b 已迁到 ops：ops.alert_incidents、ops.alert_delivery_jobs、ops.free_zone_events。旧名只剩发布窗口内的兼容视图',
    // 建表的历史迁移，以及迁移本身（SET SCHEMA 与兼容视图）。
    allow: [
      'packages/shared/migrations/20261010_payment_alerting_foundation.sql',
      'packages/shared/migrations/20261112_free_zone.sql',
      'packages/shared/migrations/20261117_db_reorg_ops_alerts_free_zone_events.sql',
      'packages/shared/migrations/20261117_db_reorg_drop_ops_compat_views.sql',
    ],
  },
  {
    id: 'moved-to-user-marks',
    pattern:
      /\b(?:vip_entry_seen_at|characters_last_seen_at|image_plaza_first_share_completed_at|growth_prompt_states|(?:choice|status|memory)_full_rules_remaining|claim_instruction_slot_modes)\b/g,
    message:
      '数据库重组 3b-1：一次性标记在 miniapp_features.user_marks（UserMarksRepository / touch_user_mark），' +
      '"已完成首发分享"= billing.image_plaza_share_rewards 有记录，指令槽旧计数器已删。新函数不要再写 settings 这些列；' +
      '已在 TEST 执行过的迁移别改原文件，另写 forward-fix（参考 20261117_db_reorg_p3b1_video_share_first_share.sql）',
    // 建列/建表/写入的历史迁移与断言脚本，以及 3b-1 迁移本身。
    allow: [
      'packages/shared/migrations/20260921_vip_billing_schema.sql',
      'packages/shared/migrations/20260924_vip_billing_schema_pg_cron_compat.sql',
      'packages/shared/migrations/20261012_image_plaza_v2.sql',
      'packages/shared/migrations/20261013_image_plaza_seed_catalog.sql',
      'packages/shared/migrations/20261013_platform_instruction_slot_windows.sql',
      'packages/shared/migrations/20261013_session_scoped_instruction_slot_modes.sql',
      // Historical video definition; the 20261117 video-share forward-fix removes this write.
      // Never rewrite applied SQL. Deploy the forward-fix after the video definition, including reruns.
      'packages/shared/migrations/20261027_media_plaza_video.sql',
      'packages/shared/migrations/20261113_growth_prompt_states.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_user_marks.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_user_marks_contract.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_clear_orphan_first_share.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_video_share_first_share.sql',
      'scripts/platform-instruction-slot-windows-assert.sql',
    ],
  },
  {
    id: 'renamed-user-preferences',
    pattern: /\bminiapp_user_settings\b/g,
    message:
      '数据库重组 3b-2：miniapp_user_settings 已改名 app_core.user_preferences（只留偏好），' +
      '资料（TG 资料、昵称、自定义头像）在 app_core.users（UserProfileRepository / refresh_user_profile）。' +
      '已在 TEST 执行过的迁移别改原文件，另写 forward-fix',
    // 建表/改表的历史迁移与断言脚本，以及重组迁移本身。
    allow: [
      'packages/shared/migrations/20260921_vip_billing_schema.sql',
      'packages/shared/migrations/20260924_vip_billing_schema_pg_cron_compat.sql',
      'packages/shared/migrations/20261012_image_plaza_v2.sql',
      'packages/shared/migrations/20261013_image_plaza_seed_catalog.sql',
      'packages/shared/migrations/20261013_platform_instruction_slot_windows.sql',
      'packages/shared/migrations/20261013_session_scoped_instruction_slot_modes.sql',
      'packages/shared/migrations/20261014_rich_reply_dynamic_mode.sql',
      'packages/shared/migrations/20261023_reply_style_options.sql',
      // Historical video share function still names the old table. The 20261117
      // video-share forward-fix removes that write after install. Never rewrite applied SQL.
      'packages/shared/migrations/20261027_media_plaza_video.sql',
      'packages/shared/migrations/20261117_drive_mode.sql',
      'packages/shared/migrations/20261117_db_reorg_ops_cs_feed.sql',
      'packages/shared/migrations/20261117_db_reorg_p3a_drop_test_funnel_stats.sql',
      'packages/shared/migrations/20261117_db_reorg_p3a_user_attributions.sql',
      'packages/shared/migrations/20261117_db_reorg_p3a_user_attributions_contract.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_clear_orphan_first_share.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_user_marks.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_user_marks_contract.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b1_video_share_first_share.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b2_user_profile.sql',
      'packages/shared/migrations/20261117_db_reorg_p3b2_user_profile_contract.sql',
      'scripts/platform-instruction-slot-windows-assert.sql',
      'scripts/platform-instruction-slot-windows-bootstrap.sql',
    ],
  },

  {
    id: 'moved-to-character-listings',
    pattern:
      /\b(?:archive_character|set_character_enabled|reorder_characters|tf_track_character_listing)\b/g,
    message:
      '数据库重组 3c：上架状态（enabled / sort_order / archived_at / last_listed_at）已从 app_core.characters 拆到 ' +
      'app_core.character_listings；直接改上下架/排序/归档的三个旧 RPC 和卡片表上的上架时间触发器已删除。' +
      '上下架走布局草稿 → admin.publish_character_layout_draft；后端读 Prisma 关系 Character.listing',
    allow: [
      'packages/shared/migrations/20261118_db_reorg_p3c_character_listings.sql',
      'packages/shared/migrations/20261118_db_reorg_p3c_character_listings_contract.sql',
      'scripts/test-db-reorg-p3c-migration.sh',
    ],
  },

  {
    id: 'moved-payment-reconcile-and-events',
    pattern:
      /\bpayment_operation_events\b|\b(?:next_reconcile_at|last_reconciled_at|reconcile_attempts|reconcile_locked_until|checkout_confirmed_at|last_checkout_confirmed_at|checkout_confirm_count|record_checkout_confirmation)\b|\b(?:listRecentUnsettled|scheduleReconciliation)\b/g,
    message:
      '数据库重组 4a：支付对账调度在 billing.payment_reconcile_jobs（只经 claim_payment_reconcile_jobs 领取与退避），' +
      '支付事件在 ops.payment_events（后端用 Prisma 原生 SQL）；payment_orders 的对账列与结账确认列已删',
    // 建表/建函数的历史迁移，以及 4a 迁移与断言脚本本身。
    allow: [
      'packages/shared/migrations/20261010_payment_alerting_foundation.sql',
      'packages/shared/migrations/20261118_db_reorg_p4a_payment_reconcile_jobs.sql',
      'packages/shared/migrations/20261118_db_reorg_p4a_payment_reconcile_jobs_contract.sql',
      'scripts/test-db-reorg-p4a-migration.sh',
    ],
  },

  {
    id: 'moved-chat-prompt-snapshot',
    pattern:
      /\b(?:setPromptHistory|setPendingRequestId|display_fallback|extractOpeningMessage|openingHistory)\b/g,
    message:
      '数据库重组 5a：prompt 定稿只由 begin_chat_generation_observation 写入 ops.chat_prompt_observations（产品路径不读）；' +
      '开场白与 request_id 只读展示投影（chat_history_display_metadata），不再从 chat_history.history 解析或兜底',
    // 建展示投影与兜底视图的历史迁移及其断言；5a 收缩（守卫要点名这些旧对象）与它的断言脚本。
    allow: [
      'packages/shared/migrations/20261111_chat_history_display_reads.sql',
      'packages/shared/migrations/tests/chat_history_display.sql',
      'packages/shared/migrations/20261119_db_reorg_p5_chat_history_contract.sql',
      'scripts/test-db-reorg-p5-migration.sh',
    ],
  },

  {
    id: 'dropped-request-timing-columns',
    pattern:
      /\b(?:first_token_emitted_ms|client_request_dispatched_ms|client_wait_finished_ms|client_first_token_received_ms|client_backgrounded|client_reported_at|chat_first_token_report)\b/g,
    message:
      '数据库重组 6a-1：chat_generation_requests 的这 6 个测速列与 miniapp_analytics.chat_first_token_report 已删除；' +
      '客户端首字、渲染延迟、切后台看 Faro roleplay.first_token / roleplay.render，交付判定只读请求表留下的交付列',
    // 建这些列与报告函数的历史迁移；6a-1 迁移（守卫要点名旧列）与它的断言脚本。
    allow: [
      'packages/shared/migrations/20261023_chat_first_token_fallback.sql',
      'packages/shared/migrations/20261023_chat_first_token_fallback_config.sql',
      'packages/shared/migrations/20261023_grafana_first_token_reader.sql',
      'packages/shared/migrations/20261117_db_reorg_revoke_reader_and_browser_grants.sql',
      'packages/shared/migrations/20261026_first_token_stage_budgets.sql',
      'packages/shared/migrations/20261026_first_token_receipt_quota_release.sql',
      'packages/shared/migrations/20261027_recoverable_chat_delivery.sql',
      'packages/shared/migrations/20261028_client_committed_first_token.sql',
      'packages/shared/migrations/20261029_first_token_receipt_recovery.sql',
      'packages/shared/migrations/20261102_first_token_server_delivery_billing.sql',
      'packages/shared/migrations/20261119_db_reorg_p6a1_request_timing_cleanup.sql',
      'scripts/test-db-reorg-p6a1-migration.sh',
    ],
  },

  {
    id: 'embedded-provider-detail-identity',
    pattern:
      /\b(?:openrouter|venice|surplusintelligence)_chat_history!(?:inner|left)\b|\blistSurplusRowsPendingBilling\b|surplus-billing-recovery/g,
    message:
      '数据库重组 6a-2b：交付身份只认 chat_generation_requests.delivery_attempt_id → chat_generation_attempts；' +
      '结算回捞候选走 experience.list_chat_settlement_candidates，不要经 PostgREST 嵌入供应商明细表判断谁交付',
    allow: [],
  },

  {
    id: 'provider-detail-tables-to-ops-llm-calls',
    pattern:
      /\bfrom\(\s*['"](?:openrouter|venice|surplusintelligence)_chat_history['"]|\b(?:OpenRouter|Venice)ChatHistoryRepository\b|\bTABLE\s*=\s*['"]surplusintelligence_chat_history['"]/g,
    message:
      '数据库重组 6a-2c：OpenRouter / Venice / Surplus 调用明细在 ops.llm_calls（每次调用一行，id = attempt id），' +
      '后端经 LlmCallRepository 与 read_surplus_call / list_surplus_request_record_candidates 等 RPC 读写',
    allow: [],
  },
  {
    id: 'dropped-card-position-snapshot',
    pattern: /\bcard_position_snapshot\b|\bcard_position_hourly_snapshot\b/g,
    message: '卡片位次快照表与每小时任务已删除（11-19 用户确认无读者）。需要位次历史请另行设计',
    allow: [
      'packages/shared/migrations/20261118_db_reorg_p3c_character_listings.sql',
      'packages/shared/migrations/20261119_db_reorg_drop_card_position_snapshot.sql',
    ],
  },

  {
    id: 'retired-chat-images',
    pattern:
      /\bchat_message_images\b|\bclaim_chat_image_jobs\b|\bsettle_image_generation\b|\/api\/v1\/images\b|\/images\b(?=['"`])|\bimage-text-model\b/g,
    message:
      '聊天配图已下线（11-19 用户确认）：任务、接口、配置与扣费函数均已删除，表只读归档。图片生成请走图片广场',
    allow: [
      'packages/shared/migrations/20260914_chat_message_images.sql',
      'packages/shared/migrations/20260914_chat_message_images_rollback.sql',
      'packages/shared/migrations/20260916_chat_image_description_drafts.sql',
      'packages/shared/migrations/20260918_expand_chat_image_prompt_limit.sql',
      'packages/shared/migrations/20260921_wallet_debit_refund.sql',
      'packages/shared/migrations/20260922_media_feature_free_trials.sql',
      'packages/shared/migrations/20260923_admin_vip_media_config.sql',
      'packages/shared/migrations/20260923_vip_strategy_media_limit_alignment.sql',
      'packages/shared/migrations/20260928_vip_media_discount_snapshots.sql',
      'packages/shared/migrations/20261119_db_reorg_retire_chat_images.sql',
    ],
  },

  {
    id: 'free-zone-calls-to-llm-calls',
    pattern: /\bfree_zone_calls\b|\brecordFreeZoneCall\b|\bsurplus-usage-export\b/g,
    message:
      '数据库重组 6a-2c-3：文本对话每次模型调用统一记在 ops.llm_calls（generation/call-ledger.ts，lane 区分收费轮与畅聊），' +
      '成本由 generation/call-costs.ts 补；不再写 miniapp_features.free_zone_calls、不再拉 Surplus 账单对账',
    allow: [
      'packages/shared/migrations/20261116_free_zone_calls.sql',
      'packages/shared/migrations/20261119_db_reorg_p6a2c3_call_ledger_expand.sql',
      'packages/shared/migrations/20261119_db_reorg_p6a2c3_free_zone_calls_contract.sql',
    ],
  },

  // ── 已整包删除的 package ────────────────────────────────────────────────
  {
    id: 'deleted-packages',
    pattern: /@miniapp\/(?:db-types|sync-engine|st-extension)|@repo\/bridge-protocol/g,
    message: '这些包已随 ST 清理整包删除。对外类型走 @miniapp/shared',
  },

  // ── 已退场的旧实现标识符 ────────────────────────────────────────────────
  {
    id: 'retired-identifiers',
    pattern:
      /\bapiStreamClient\b|\bplatform_presets\b|\bchat_engine_mode\b|routes\/llm-proxy|\bdeduct_wallet_credits\b/g,
    message:
      'ST 时代残留：SSE 客户端用 lib/api/conversation-stream.ts；预设（088）与 chat_engine_mode（083）已删；扣费走 charge_llm_usage',
  },

  {
    id: 'legacy-model-tiers-contract',
    pattern:
      /\bGetModelTiersData\b|\buseModelTiersQuery\b|\/api\/platform\/models\b|\bllm_model_tiers\b|\blegacyTiersToCatalog\b/g,
    message:
      '旧模型档位已退场：runtime_config 只读 llm_model_catalog（040 起），对外只有 GET /api/v1/models/config（PublicModelCatalog）一种形状，前端走 useModelCatalogQuery',
    // 20261117 重组 1e：删除遗留的 llm_model_tiers 运行配置行本身。
    allow: ['packages/shared/migrations/20261117_db_reorg_managed_config_keys.sql'],
  },
  {
    id: 'st-handle',
    pattern: /\bst_handle\b|\bst_initialized_at\b|\bderiveStHandle\b|st-bridge/g,
    message: 'ST 身份映射已退场（迁移 111/112）。用户身份只用 app_core.users.tg_id',
    // Read-only historical eligibility evidence: production still retains the optional marker.
    // No provisioning, identity mapping or writes to the retired column.
    allow: [
      'packages/shared/migrations/20261111_mujian_entry_funnel.sql',
      'scripts/mujian-entry-assertions.sql',
      // 20261117 重组 1d：删除 st_handle 列本身（st_initialized_at 仍作幕间资格依据，阶段 3 迁走）。
      'packages/shared/migrations/20261117_db_reorg_cleanup.sql',
      // 20261117 重组 3a：st_initialized_at 作只读历史证据搬到 miniapp_traffic.user_attributions，并删 users 上的列。
      'packages/shared/migrations/20261117_db_reorg_p3a_user_attributions.sql',
      'packages/shared/migrations/20261117_db_reorg_p3a_user_attributions_contract.sql',
      'packages/shared/migrations/20261117_db_reorg_p3a_drop_test_funnel_stats.sql',
    ],
  },

  // ── 一个关键行为一条主路径 ──────────────────────────────────────────────
  {
    id: 'chat-history-writer',
    pattern: /from\(\s*['"]chat_history['"]\s*\)/g,
    message:
      'experience.chat_history 只能由 ConversationHistoryRepository 读写（列归属见该文件头注释）',
    allow: [
      'packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts',
      // Existing repository delegation extracted upstream; not an independent writer.
      'packages/backend/src/infrastructure/repositories/conversation-history-billing.ts',
      // OpenRouter 元数据回填先从其专属表有界筛选候选 ID，再只读父记录；不写 chat_history。
      'packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.ts',
      // Surplus 无专属元数据表；该 provider-specific helper 仅由 ConversationHistoryRepository
      // 委托做未结算行的有界只读扫描，不提供写入出口。
      'packages/backend/src/infrastructure/repositories/surplus-billing-recovery.ts',
      // 集成测试直连库造数据、断言与清理，不经业务链路
      'packages/backend/src/infrastructure/repositories/conversations.integration.test.ts',
      // Local disposable PG/PostgREST fixtures only; no application writer or remote database.
      'packages/backend/src/infrastructure/repositories/GenerationObservationRepository.integration.test.ts',
    ],
  },
  {
    id: 'llm-chat-upstream',
    pattern: /['"`][^'"`]*\/chat\/completions/g,
    message:
      '聊天 LLM 只有一个出口：features/generation/upstream.ts（架构铁律 6）。语音写稿与图片广场辅助任务是按文件列明的例外',
    allow: [
      'packages/backend/src/features/generation/upstream.ts',
      'packages/backend/src/features/generation/upstream.test.ts',
      // Shared provider capability data declares the relative path; only upstream.ts executes it.
      'packages/shared/src/api/model-providers.ts',
      // 图片广场非流式辅助任务：作品提示词翻译/标签分类，不生成聊天回复、不读写聊天历史，
      // 不进入用户聊天计费；调用仍归 generation/ 管理，不能豁免整个目录。
      'packages/backend/src/features/generation/image-plaza-prompt-translate.ts',
      'packages/backend/src/features/generation/image-plaza-tagging.ts',
      // 验证同一辅助分类端点及失败降级，不是另一条运行时出口。
      'packages/backend/src/features/image-plaza/tagging.test.ts',
      // 语音写稿的 DeepSeek 端点：与聊天不同供应商、非流式、抽取任务、按次计费，
      // 业务上确实独立（理由见 features/voice/voice-draft.ts 与 features/voice/billing.ts）
      'packages/backend/src/platform/config.ts',
      'packages/backend/src/features/voice/voice-draft.test.ts',
    ],
  },
  {
    id: 'openrouter-generation-api',
    pattern: /openrouter\.ai\/api\/v1\/generation/g,
    message:
      'OpenRouter 用量统计只由 features/generation/openrouter-metadata.ts 读取，两个消费方共用同一套字段映射',
    allow: ['packages/backend/src/features/generation/openrouter-metadata.ts'],
  },
  {
    id: 'payment-settlement',
    pattern: /\bcomplete_payment_order\b/g,
    message:
      '支付到账只有一个出口：features/payment/usecases/PaymentSettlement.settlePaidOrder（四路入账都收口在它）',
    allow: [
      'packages/backend/src/features/payment/usecases/PaymentSettlement.ts',
      'packages/backend/src/infrastructure/repositories/MiniappPaymentOrderRepository.ts',
      // 同一数据库履约出口的 VIP 兼容函数体，不是第二条应用入账路径。
      'packages/shared/migrations/20260921_vip_payment_fulfillment.sql',
      // T3A 只替换同一函数体，让履约读取订单快照而不是写死 1399/2888。
      'packages/shared/migrations/20260923_vip_strategy_config.sql',
      // 同一履约出口支持两钱包订单快照，保留原结算幂等和收入语义。
      'packages/shared/migrations/20261105_vip_mixed_rewards.sql',
      // 告警 foundation 仅在迁移 preflight 中确认既有履约出口仍存在，
      // 不调用、替换或新增任何应用侧结算路径。
      'packages/shared/migrations/20261010_payment_alerting_foundation.sql',
    ],
  },
  {
    id: 'llm-usage-charge',
    pattern: /\bchargeLlmUsage\b/g,
    message:
      'LLM 定档扣费只有一个出口：features/generation/apply-charge.ts。settle / sync-job 组 command 后调 applyLlmCharge，禁止再直接 chargeLlmUsage',
    allow: [
      'packages/backend/src/features/generation/apply-charge.ts',
      'packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts',
      // Repository contract tests validate terminal archived RPC results; no runtime billing path.
      'packages/backend/src/infrastructure/repositories/MiniappWalletRepository.test.ts',
      'packages/backend/src/features/generation/apply-charge.test.ts',
      'packages/backend/src/features/generation/sync-job.test.ts',
    ],
  },
  {
    id: 'wallet-bonus-grant',
    // 逐行匹配「bonus_credits = bonus_credits + …」这一句加值语句；扣费是减号，不会误伤。
    pattern: /\bbonus_credits\s*=\s*(?:billing\.user_wallets\.)?bonus_credits\s*\+/g,
    message:
      '星尘发放只有一个入口：billing.grant_bonus_credits（钱包 upsert + 加值 + 流水）。发奖 RPC 组好 entry_type / reference / metadata 后调它，禁止再自己 UPDATE user_wallets',
    allow: [
      'packages/shared/migrations/20260911_billing_grant_bonus_credits.sql',
      // 20261012 已是仓库历史；20261013_image_plaza_seed_catalog.sql 会立即以
      // billing.grant_bonus_credits 重建该 RPC，兼容已应用与未应用的环境。
      'packages/shared/migrations/20261012_image_plaza_v2.sql',
    ],
  },
];

function shouldScan(path) {
  return SCAN_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function collectFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      if (entry === 'migrations') {
        collectNewMigrations(full, out);
        continue;
      }
      collectFiles(full, out);
    } else if (shouldScan(full)) {
      out.push(full);
    }
  }
  return out;
}

/** migrations 目录顶层：只收日期命名的新迁移，不递归（archive/ 是留档）。 */
function collectNewMigrations(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!NEW_MIGRATION_PATTERN.test(entry)) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      // 忽略读取失败的条目
    }
  }
  return out;
}

/** packages 下只扫 src 与包根配置，避免扫进各包的构建产物与夹带资源。 */
function scanTargets() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const rootPath = join(repoRoot, root);
    let stats;
    try {
      stats = statSync(rootPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    if (root === 'packages') {
      for (const pkg of readdirSync(rootPath)) {
        if (pkg.startsWith('.')) continue;
        collectFiles(join(rootPath, pkg, 'src'), files);
        // 日期命名的新迁移也算活代码（PR 阶段尚未执行）；三位编号存量不扫。
        collectNewMigrations(join(rootPath, pkg, 'migrations'), files);
      }
    } else {
      collectFiles(rootPath, files);
    }
  }
  return files;
}

const selfPath = relative(repoRoot, fileURLToPath(import.meta.url))
  .split(sep)
  .join('/');
const violations = [];

for (const file of scanTargets()) {
  const relPath = relative(repoRoot, file).split(sep).join('/');
  if (relPath === selfPath) continue;

  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  for (const rule of RULES) {
    if (rule.allow?.includes(relPath)) continue;
    if (!new RegExp(rule.pattern.source, rule.pattern.flags).test(source)) continue;

    lines.forEach((line, index) => {
      const matcher = new RegExp(rule.pattern.source, rule.pattern.flags);
      const match = matcher.exec(line);
      if (!match) return;
      violations.push({
        rule,
        file: relPath,
        line: index + 1,
        snippet: line.trim().slice(0, 160),
      });
    });
  }
}

if (violations.length === 0) {
  console.log('legacy-reference guard: 未发现旧链路 / 旧 schema 的新引用');
  process.exit(0);
}

console.error(`\nlegacy-reference guard 发现 ${violations.length} 处违规：\n`);

const byRule = new Map();
for (const violation of violations) {
  const bucket = byRule.get(violation.rule.id) ?? [];
  bucket.push(violation);
  byRule.set(violation.rule.id, bucket);
}

for (const [ruleId, hits] of byRule) {
  console.error(`[${ruleId}] ${hits[0].rule.message}`);
  for (const hit of hits) {
    console.error(`    ${hit.file}:${hit.line}  ${hit.snippet}`);
  }
  console.error('');
}

console.error(
  '如果这确实是一条业务上必须独立的新路径，请在 PR 里说明理由，并把它加进\n' +
    'scripts/check-legacy-references.mjs 对应规则的 allow 清单。\n'
);
process.exit(1);
