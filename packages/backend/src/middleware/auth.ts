import { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac } from 'crypto';
import { config } from '../platform/config.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  added_to_attachment_menu?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
}

/**
 * 校验 Telegram initData
 * @param initDataStr 来自 X-Init-Data header 的字符串
 * @returns 校验成功返回 TelegramUser 对象，失败抛出错误
 */
export function verifyTelegramInitData(initDataStr: string): TelegramUser {
  // 允许本地测试 Bypass
  if (process.env.MOCK_AUTH === '1') {
    try {
      const urlParams = new URLSearchParams(initDataStr);
      return JSON.parse(decodeURIComponent(urlParams.get('user')!)) as TelegramUser;
    } catch (e) {
      // ignore, fallback
    }
  }

  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }

  const urlParams = new URLSearchParams(initDataStr);
  const hash = urlParams.get('hash');

  if (!hash) {
    throw new Error('Missing hash in initData');
  }

  // Remove hash to prepare the data check string
  urlParams.delete('hash');

  // Sort parameters alphabetically
  const params: string[] = [];
  for (const [key, value] of urlParams.entries()) {
    params.push(`${key}=${value}`);
  }
  params.sort();

  const dataCheckString = params.join('\n');

  // Create secret key
  const secretKey = createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();

  // Create signature
  const signature = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (signature !== hash) {
    throw new Error('Invalid Telegram signature');
  }

  // Check expiration (auth_date is in seconds)
  const authDateStr = urlParams.get('auth_date');
  if (authDateStr) {
    const authDate = parseInt(authDateStr, 10);
    const now = Math.floor(Date.now() / 1000);
    // 24 hours expiration
    if (now - authDate > 24 * 60 * 60) {
      throw new Error('Telegram authentication expired');
    }
  }

  // Parse user info
  const userStr = urlParams.get('user');
  if (!userStr) {
    throw new Error('Missing user info in initData');
  }

  try {
    return JSON.parse(userStr) as TelegramUser;
  } catch (e) {
    throw new Error('Invalid user info format');
  }
}

/**
 * Fastify preHandler 钩子，用于需要鉴权的路由
 */
export async function requireTelegramAuth(request: FastifyRequest, reply: FastifyReply) {
  const initData = request.headers['x-init-data'];

  if (!initData || typeof initData !== 'string') {
    return reply.status(401).send({
      success: false,
      error: { message: 'Missing or invalid X-Init-Data header' },
    });
  }

  try {
    const user = verifyTelegramInitData(initData);
    // 将 user 挂载到 request 上，需配合 type augmentation
    request.user = user;
  } catch (error) {
    request.log.warn({ err: error }, 'Telegram auth failed');
    return reply.status(401).send({
      success: false,
      error: { message: error instanceof Error ? error.message : 'Unauthorized' },
    });
  }
}
