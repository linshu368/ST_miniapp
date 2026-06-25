import { FastifyInstance } from 'fastify';
import { config } from '../platform/config.js';
import { getOrCreateDbUser } from '../lib/user.js';
import type { TelegramUser } from '../middleware/auth.js';
import { MiniappWishRoleRepository } from '../infrastructure/repositories/MiniappWishRoleRepository.js';

const WISH_ENTRY_BUTTON = '✨ 我想要的角色';
const WISH_DONE_BUTTON = '💖 就这样吧';
const WISH_COMMAND = '/wish';
const MIN_WISH_LENGTH = 8;
const TEST_WISH_REWARD_CREDITS = 1;

interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
  };
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export default async function botRoutes(app: FastifyInstance) {
  const wishes = new MiniappWishRoleRepository();

  app.post('/api/bot/telegram/webhook', async (request, reply) => {
    if (!config.telegramBotToken) {
      return reply.status(500).send({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' });
    }

    if (config.telegramWebhookSecret) {
      const secret = request.headers['x-telegram-bot-api-secret-token'];
      if (secret !== config.telegramWebhookSecret) {
        return reply.status(401).send({ ok: false, error: 'Invalid Telegram webhook secret' });
      }
    }

    const update = request.body as TelegramUpdate;

    try {
      if (update.callback_query) {
        await handleCallback(update.callback_query, wishes);
      } else if (update.message) {
        await handleMessage(update.message, wishes);
      }
    } catch (error) {
      request.log.error({ err: error }, 'Telegram bot webhook failed');
    }

    return reply.send({ ok: true });
  });
}

async function handleMessage(message: TelegramMessage, wishes: MiniappWishRoleRepository) {
  const text = message.text?.trim();
  const tgUser = message.from;
  if (!tgUser || !text) return;

  const dbUser = await getOrCreateDbUser(tgUser);

  if (text === '/start') {
    await wishes.clearSession(tgUser.id);
    await closeAwaitingExtraIfAny(wishes, dbUser.id, tgUser.id);
    await sendMessage({
      chatId: message.chat.id,
      text: '欢迎来到星尘 MiniApp 测试环境。你可以打开 MiniApp，也可以告诉我们你想要什么样的角色。',
      replyMarkup: mainKeyboard(),
    });
    return;
  }

  if (text === WISH_ENTRY_BUTTON || text === WISH_COMMAND) {
    await closeAwaitingExtraIfAny(wishes, dbUser.id, tgUser.id);
    await wishes.startSession({ telegramUserId: tgUser.id, dbUserId: dbUser.id });
    await sendMessage({
      chatId: message.chat.id,
      text:
        '💫 说说你想要什么样的角色？\n\n' +
        '一句话就行，比如：\n' +
        '- “霸道总裁但其实是社恐”\n' +
        '- “温柔姐姐，会哄人睡觉”\n' +
        '- “赛博朋克世界的酒吧老板娘”\n\n' +
        '🔒 你的许愿完全私密，放心大胆说 👇',
      replyMarkup: mainKeyboard(),
    });
    return;
  }

  const session = await wishes.getSession(tgUser.id);
  if (session?.state === 'awaiting_wish') {
    if (countChars(text) <= MIN_WISH_LENGTH) {
      await sendMessage({
        chatId: message.chat.id,
        text: '再多说几个字呀，不然我猜不到你想要什么样的～',
        replyMarkup: mainKeyboard(),
      });
      return;
    }

    try {
      const wish = await wishes.createWish({
        dbUserId: dbUser.id,
        telegramUserId: tgUser.id,
        wishText: text,
        rewardCredits: TEST_WISH_REWARD_CREDITS,
      });
      await wishes.clearSession(tgUser.id);
      await sendMessage({
        chatId: message.chat.id,
        text:
          `✅ 收到！奖励你 ${TEST_WISH_REWARD_CREDITS} 星尘 ✨\n\n` +
          '如果你还有更具体的想法，比如你和 ta 的关系、性格细节、故事背景，可以继续说～\n' +
          '没有的话点下面就好 👇',
        replyMarkup: {
          inline_keyboard: [[{ text: WISH_DONE_BUTTON, callback_data: `wish_done:${wish.id}` }]],
        },
      });
    } catch (error) {
      const messageText =
        error instanceof Error && error.message.includes('wish limit reached')
          ? '你今天的许愿次数已经用完啦，明天再来～'
          : '许愿暂时保存失败了，稍后再试一下～';
      await wishes.clearSession(tgUser.id);
      await sendMessage({
        chatId: message.chat.id,
        text: messageText,
        replyMarkup: mainKeyboard(),
      });
    }
    return;
  }

  const latestWish = await wishes.findLatestAwaitingExtra({
    dbUserId: dbUser.id,
    telegramUserId: tgUser.id,
  });
  if (latestWish) {
    await wishes.completeWish({
      dbUserId: dbUser.id,
      telegramUserId: tgUser.id,
      wishId: latestWish.id,
      extraText: text,
    });
    await sendMessage({
      chatId: message.chat.id,
      text: '✅ 记下了！我们会认真看每一条许愿～',
      replyMarkup: mainKeyboard(),
    });
  }
}

async function handleCallback(callback: TelegramCallbackQuery, wishes: MiniappWishRoleRepository) {
  const data = callback.data ?? '';
  if (!data.startsWith('wish_done:')) return;

  const wishId = data.slice('wish_done:'.length);
  const chatId = callback.message?.chat.id;
  const dbUser = await getOrCreateDbUser(callback.from);

  await wishes.completeWish({
    dbUserId: dbUser.id,
    telegramUserId: callback.from.id,
    wishId,
  });

  await answerCallbackQuery(callback.id);
  if (chatId !== undefined) {
    await sendMessage({
      chatId,
      text: '记下了！我们会认真看每一条许愿～',
      replyMarkup: mainKeyboard(),
    });
  }
}

async function closeAwaitingExtraIfAny(
  wishes: MiniappWishRoleRepository,
  dbUserId: string,
  telegramUserId: number
) {
  const latestWish = await wishes.findLatestAwaitingExtra({ dbUserId, telegramUserId });
  if (!latestWish) return;
  await wishes.completeWish({ dbUserId, telegramUserId, wishId: latestWish.id });
}

function mainKeyboard() {
  return {
    keyboard: [[{ text: WISH_ENTRY_BUTTON }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function countChars(value: string): number {
  return Array.from(value.trim()).length;
}

async function sendMessage(input: {
  chatId: number;
  text: string;
  replyMarkup?: Record<string, unknown>;
}) {
  const body = {
    chat_id: input.chatId,
    text: input.text,
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  };

  await callTelegram('sendMessage', body);
}

async function answerCallbackQuery(callbackQueryId: string) {
  await callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
  });
}

async function callTelegram(method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram ${method} failed (${response.status}): ${text}`);
  }
}
