import { prisma } from './db.js';
import type { TelegramUser } from '../middleware/auth.js';

/**
 * 确保数据库中有对应的 User 记录并返回，
 * 用于将会话的 user_id（UUID）与 Telegram 用户的 tg_id 关联。
 */
export async function getOrCreateDbUser(tgUser: TelegramUser) {
  const tgIdStr = tgUser.id.toString();

  return prisma.user.upsert({
    where: { tg_id: tgIdStr },
    update: {},
    create: {
      tg_id: tgIdStr,
    },
  });
}
