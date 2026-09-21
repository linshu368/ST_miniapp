import 'dotenv/config';
import { createDatabaseConfig, resolveDefaultUserAvatarUrl } from '@miniapp/shared';
import { resolveBatchLabSourceConfig } from '../features/batch-lab/source-config.js';

const nodeEnv = process.env.NODE_ENV || 'development';
const databaseConfig = createDatabaseConfig({
  env: process.env,
  nodeEnv,
  variableNames: [
    'DATABASE_URL',
    'DIRECT_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PROJECT_REF',
  ],
});

const batchLabSourceEnvironment = process.env.BATCH_LAB_SAMPLE_SOURCE_ENV || 'test';
if (batchLabSourceEnvironment !== 'test' && batchLabSourceEnvironment !== 'production') {
  throw new Error('BATCH_LAB_SAMPLE_SOURCE_ENV must be test or production');
}
const batchLabSourceConfig = resolveBatchLabSourceConfig({
  env: process.env,
  nodeEnv,
  backendEnvironment: databaseConfig.environment,
  sourceEnvironment: batchLabSourceEnvironment,
  testProjectRef: databaseConfig.testProjectRef,
  prodProjectRef: databaseConfig.prodProjectRef,
});

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  csPlatformUrl: process.env.CS_PLATFORM_URL || 'https://st-cs-platform.vercel.app',
  adminPlatformUrl: process.env.ADMIN_PLATFORM_URL || 'https://st-admin-platform.vercel.app',
  batchLab: {
    enabled: process.env.BATCH_LAB_ENABLED === 'true',
    url: process.env.BATCH_LAB_URL || '',
    sourceEnvironment: batchLabSourceEnvironment,
    source: batchLabSourceConfig,
  },
  nodeEnv,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  botInternalSecret: process.env.BOT_INTERNAL_SECRET || '',
  telegramCommunityBotToken: process.env.TELEGRAM_COMMUNITY_BOT_TOKEN || '',
  // CS 必须使用当前数据库环境对应的 MiniApp Bot；否则同一 tg_id 对另一 Bot 会 chat not found。
  csTelegramBotToken: process.env.TELEGRAM_BOT_TOKEN || process.env.CS_TELEGRAM_BOT_TOKEN || '',
  csAdminToken: process.env.CS_ADMIN_TOKEN || '',
  csTelegramWebhookSecret: process.env.CS_TELEGRAM_WEBHOOK_SECRET || '',

  // ── 数据库环境隔离 ────────────────────────────────────────────────────────
  database: {
    environment: databaseConfig.environment,
    projectRef: databaseConfig.projectRef,
    prodProjectRef: databaseConfig.prodProjectRef,
    testProjectRef: databaseConfig.testProjectRef,
    target: databaseConfig.target,
  },

  // ── Supabase ───────────────────────────────────────────────────────────────
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  /** 平台默认头像。生产须指向生产 Supabase，未配置时回退到测试环境地址。 */
  defaultUserAvatarUrl: resolveDefaultUserAvatarUrl(process.env.DEFAULT_USER_AVATAR_URL),

  chatHistorySyncEnabled: process.env.CHAT_HISTORY_SYNC_ENABLED !== 'false',
  /** 大厅推荐排序分的每日刷新。关掉后读路径退回运营顺序，不影响其它功能 */
  lobbyRankingRefreshEnabled: process.env.LOBBY_RANKING_REFRESH_ENABLED !== 'false',

  // ── 角色语音 ───────────────────────────────────────────────────────────────
  // 两段式：先用 DeepSeek 把回复写成台词，再用 MiniMax 合成 mp3。
  // 两段是不同供应商、不同 key，缺任何一把语音功能都不可用。
  voice: {
    /** MiniMax，只用于 TTS 合成 */
    apiKey: process.env.MINIMAX_API_KEY || '',
    ttsUrl: process.env.MINIMAX_TTS_URL || 'https://api.minimaxi.com/v1/t2a_v2',
    /** 单次上游调用的超时。HD 模型合成长文本可以到几十秒 */
    timeoutMs: parseInt(process.env.MINIMAX_TIMEOUT_MS || '120000', 10),

    /** DeepSeek，只用于写稿 */
    draft: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      url: process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    },
  },

  // 聊天图片生成：DeepSeek 复用 voice.draft；这里仅放 Liaobots/Grok 与图片链路超时。
  image: {
    liaobotsAuth: process.env.LIAOBOTS_AUTH || '',
    liaobotsBase: process.env.LIAOBOTS_BASE || 'https://ai.liaobots1.work',
    grokModel: process.env.GROK_MODEL || 'grok-imagine-image-quality',
    replicateToken: process.env.REPLICATE_TOKEN || '',
    zModel: process.env.Z_MODEL || 'prunaai/z-image-turbo',
    replicateBase: process.env.REPLICATE_BASE || 'https://api.replicate.com/v1',
    timeoutMs: parseInt(process.env.IMAGE_GENERATION_TIMEOUT_MS || '180000', 10),
    downloadTimeoutMs: parseInt(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS || '60000', 10),
    workerEnabled: process.env.IMAGE_WORKER_ENABLED !== 'false',
    workerIntervalMs: parseInt(process.env.IMAGE_WORKER_INTERVAL_MS || '3000', 10),
    workerLeaseSeconds: parseInt(process.env.IMAGE_WORKER_LEASE_SECONDS || '180', 10),
  },

  // ── MiniApp 支付 ───────────────────────────────────────────────────────────
  payment: {
    enabled: process.env.PAYMENT_ENABLED === 'true',
    baseUrl: process.env.PAYMENT_BASE_URL || 'https://zq.716faka.com',
    merchantId: process.env.PAYMENT_MERCHANT_ID || '',
    merchantPrivateKey: process.env.PAYMENT_MERCHANT_PRIVATE_KEY || '',
    platformPublicKey: process.env.PAYMENT_PLATFORM_PUBLIC_KEY || '',
    notifyUrl: process.env.PAYMENT_NOTIFY_URL || '',
    returnUrl: process.env.PAYMENT_RETURN_URL || '',
  },

  // ── PostHog 服务端 capture（支付终态等非关键事件）──────────────────────────
  // 这是进程环境密钥，走 config.ts；不是 app_core.runtime_config 的运营配置。
  // 缺 key / 非法 host 时 adapter no-op，不得影响支付结算。
  posthog: {
    apiKey: process.env.POSTHOG_API_KEY || '',
    host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    timeoutMs: parseInt(process.env.POSTHOG_TIMEOUT_MS || '3000', 10),
  },
} as const;
