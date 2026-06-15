import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV || 'development',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // ── ST 相关 ──────────────────────────────────────────────────────────────
  /** ST 服务地址，Bridge 用于登录和反向代理 */
  stBaseUrl: process.env.ST_BASE_URL || 'http://localhost:8000',
  /** 用户密码派生密钥，与 sync-engine 保持一致 */
  stUserPasswordSecret: process.env.ST_USER_PASSWORD_SECRET || '',

  // ── Provision 服务 ────────────────────────────────────────────────────────
  /** sync-engine Bridge API 地址，Bridge 调用 provision */
  stProvisionUrl: process.env.ST_PROVISION_URL || 'http://127.0.0.1:9091',
} as const;
