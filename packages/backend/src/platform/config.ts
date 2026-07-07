import 'dotenv/config';
import { createDatabaseConfig } from '@miniapp/shared';

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

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  csPlatformUrl: process.env.CS_PLATFORM_URL || 'https://st-cs-platform.vercel.app',
  nodeEnv,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  botInternalSecret: process.env.BOT_INTERNAL_SECRET || '',
  csTelegramBotToken: process.env.CS_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '',
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

  // ── ST 相关 ──────────────────────────────────────────────────────────────
  /** ST 服务地址，Bridge 用于登录和反向代理 */
  stBaseUrl: process.env.ST_BASE_URL || 'http://localhost:8000',
  /** 用户密码派生密钥，与 sync-engine 保持一致 */
  stUserPasswordSecret: process.env.ST_USER_PASSWORD_SECRET || '',

  // ── Provision 服务 ────────────────────────────────────────────────────────
  /** sync-engine Bridge API 地址，Bridge 调用 provision */
  stProvisionUrl: process.env.ST_PROVISION_URL || 'http://127.0.0.1:9091',

  // ── MiniApp 支付 ───────────────────────────────────────────────────────────
  payment: {
    enabled: process.env.PAYMENT_ENABLED === 'true',
    merchantId: process.env.PAYMENT_MERCHANT_ID || '',
    merchantKey: process.env.PAYMENT_MERCHANT_KEY || '',
    baseUrl: process.env.PAYMENT_BASE_URL || 'http://jlusdt.com',
    notifyUrl: process.env.PAYMENT_NOTIFY_URL || '',
    returnUrl: process.env.PAYMENT_RETURN_URL || '',
  },
} as const;
