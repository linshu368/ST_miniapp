import { createDatabaseConfig, resolveDefaultUserAvatarUrl } from '@miniapp/shared';
import 'dotenv/config';

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

function engineeringTelemetryEndpoint(): string {
  if (process.env.ENGINEERING_TELEMETRY_ENABLED !== 'true') return '';
  try {
    const endpoint = new URL(process.env.ENGINEERING_OTLP_ENDPOINT || '');
    // HTTP 仅用于同环境私网 Collector；Cloud 凭证只配置在 Collector，不交给 API。
    const privateHttp =
      endpoint.protocol === 'http:' &&
      (endpoint.hostname.endsWith('.railway.internal') ||
        ['localhost', '127.0.0.1', '[::1]', 'alloy'].includes(endpoint.hostname));
    if (
      (endpoint.protocol !== 'https:' && !privateHttp) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      throw new Error();
    return endpoint.origin;
  } catch {
    throw new Error(
      'ENGINEERING_OTLP_ENDPOINT 必须是私网 Alloy HTTP 或 HTTPS 根地址，不得包含凭证、路径或查询参数'
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  frontendAllowedOrigins: (process.env.FRONTEND_ALLOWED_ORIGINS || '')
    .split(',')
    .filter((value) => value.trim()),
  devAuthBypass: process.env.DEV_AUTH_BYPASS === '1',
  adminPlatformUrl: process.env.ADMIN_PLATFORM_URL || 'https://st-admin-platform.vercel.app',
  nodeEnv,
  engineeringTelemetry: {
    enabled: process.env.ENGINEERING_TELEMETRY_ENABLED === 'true',
    endpoint: engineeringTelemetryEndpoint(),
    environment: databaseConfig.target,
    version: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
  },
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramMiniappShortName: process.env.MINIAPP_SHORT_NAME || 'app',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  botInternalSecret: process.env.BOT_INTERNAL_SECRET || '',
  telegramCommunityBotToken: process.env.TELEGRAM_COMMUNITY_BOT_TOKEN || '',
  // 独立客服服务（linshu368/ST_cs_platform）：Bot 私聊消息转发过去、/api/support/* 代理过去。
  csService: {
    url: (process.env.CS_SERVICE_URL || '').replace(/\/$/, ''),
    secret: process.env.CS_SERVICE_SECRET || '',
  },

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

  // 会话长期记忆后台压缩 worker；本地调试可用 STORY_MEMORY_WORKER_ENABLED=false 关闭。
  // 是否生成/注入由运营配置 story_memory_config.enabled 控制。
  storyMemory: {
    workerEnabled: process.env.STORY_MEMORY_WORKER_ENABLED !== 'false',
  },

  // Venice 出站可选代理：仅本地开发填写 VENICE_HTTPS_PROXY；Railway/生产留空直连。
  venice: {
    httpsProxy: process.env.VENICE_HTTPS_PROXY?.trim() || '',
  },

  // 图片广场使用独立 Venice 图片链路；密钥只从服务端环境读取。
  // 分享自动打标复用同一组 VENICE_*，默认模型 deepseek-v4-1-flash（可用 IMAGE_PLAZA_TAGGING_MODEL 覆盖）。
  imagePlaza: {
    apiKey: process.env.VENICE_API_KEY || '',
    baseUrl:
      process.env.VENICE_API_BASE_URL ||
      process.env.VENICE_API_BASE ||
      'https://api.venice.ai/api/v1',
    taggingModel: process.env.IMAGE_PLAZA_TAGGING_MODEL?.trim() || 'deepseek-v4-1-flash',
    timeoutMs: parseInt(process.env.IMAGE_PLAZA_TIMEOUT_MS || '180000', 10),
    workerEnabled: process.env.IMAGE_PLAZA_WORKER_ENABLED !== 'false',
    workerIntervalMs: parseInt(process.env.IMAGE_PLAZA_WORKER_INTERVAL_MS || '3000', 10),
    workerLeaseSeconds: parseInt(process.env.IMAGE_PLAZA_WORKER_LEASE_SECONDS || '240', 10),
  },

  // ── MiniApp 支付 ───────────────────────────────────────────────────────────
  payment: {
    trustRailwayEdge: Boolean(process.env.RAILWAY_ENVIRONMENT_NAME),
    enabled: process.env.PAYMENT_ENABLED === 'true',
    returnUrl: process.env.PAYMENT_RETURN_URL || '',
    notifyUrl: process.env.PAYMENT_NOTIFY_URL || '',
    epay: {
      baseUrl: process.env.TTZF_BASE_URL || 'https://ttzf8.com/api',
      appId: process.env.TTZF_APP_ID?.trim() || '',
      appKey: process.env.TTZF_APP_KEY?.trim() || '',
    },
  },

  // 独立 Cron 才消费这些参数；不改变用户建单或支付恢复开关。
  paymentProbe: {
    enabled: process.env.PAYMENT_PROBE_ENABLED === 'true',
    channel: process.env.PAYMENT_PROBE_CHANNEL?.trim() || 'alipay',
    preview:
      process.env.SENTRY_ENVIRONMENT === 'preview' ||
      /^(?:pr-|preview(?:-|$))/i.test(process.env.RAILWAY_ENVIRONMENT_NAME || ''),
  },

  // 运营平台 CLI 免密登录白名单（逗号分隔邮箱）。为空时 /api/admin/cli/session 关闭。
  adminCli: {
    allowedEmails: (process.env.ADMIN_CLI_ALLOWED_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },

  // Webhook 是部署 secret；是否发送、重试和限流属于 runtime_config.alerting，默认关闭。
  alerting: {
    feishuWebhookUrl: process.env.FEISHU_ALERT_WEBHOOK_URL || '',
    // Sentry → 后端 webhook 的共享密钥；为空时该入口一律 401（安全默认）。
    sentryWebhookSecret: process.env.SENTRY_ALERT_WEBHOOK_SECRET || '',
    // Sentry Internal Integration 的 Client Secret，用于校验 sentry-hook-signature。
    sentryClientSecret: process.env.SENTRY_CLIENT_SECRET || '',
  },
} as const;
