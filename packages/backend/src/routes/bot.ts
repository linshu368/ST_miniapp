import { FastifyInstance } from 'fastify';
import { ok, fail, type TelegramGroupMessageInput } from '@miniapp/shared';
import { config } from '../platform/config.js';
import { getOrCreateMiniappUserByTgId, recordBotStart } from '../lib/user.js';
import { forwardBotMessageToCs, forwardGroupMessageToCs } from '../lib/cs-service.js';
import { captureBackendException } from '../lib/sentry.js';

interface BotStartRequestBody {
  tg_id?: unknown;
  source_id?: unknown;
}

interface TelegramWebhookMessage {
  message_id?: number;
  message_thread_id?: number;
  date?: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  /** 同一张图的多个尺寸，最后一个最大 */
  photo?: Array<{ file_id?: string }>;
  /** 用户「以文件发送」的截图会是 document */
  document?: { file_id?: string; mime_type?: string };
  from?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    is_bot?: boolean;
  };
  chat?: { id?: number; type?: string; title?: string };
  sender_chat?: { id?: number; title?: string };
  reply_to_message?: { message_id?: number };
}

interface TelegramWebhookUpdate {
  message?: TelegramWebhookMessage;
  edited_message?: TelegramWebhookMessage;
}

export default async function botRoutes(app: FastifyInstance) {
  // @frontend-ready: false - internal bot endpoint
  app.post('/api/internal/bot/start', async (request, reply) => {
    const secret = request.headers['x-bot-internal-secret'];
    if (!config.botInternalSecret || secret !== config.botInternalSecret) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const body = (request.body ?? {}) as BotStartRequestBody;
    const tgId = normalizeTelegramId(body.tg_id);
    if (!tgId) {
      return reply.status(400).send(fail('BAD_REQUEST', 'tg_id is required'));
    }

    const sourceId = normalizeNullableText(body.source_id, 128);
    try {
      const user = await recordBotStart(tgId, sourceId);
      return reply.send(
        ok({
          user_id: user.id,
          tg_id: user.tg_id,
          bot_entered_at: user.bot_entered_at,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bot start recording failed';
      return reply.status(500).send(fail('INTERNAL_ERROR', message));
    }
  });

  // @frontend-ready: false - Telegram Bot webhook
  app.post('/api/telegram/webhook', async (request, reply) => {
    const secret = request.headers['x-telegram-bot-api-secret-token'];
    if (!config.telegramWebhookSecret || secret !== config.telegramWebhookSecret) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const update = (request.body ?? {}) as TelegramWebhookUpdate;
    const groupMessage = update.message ?? update.edited_message;
    if (groupMessage?.chat?.type === 'group' || groupMessage?.chat?.type === 'supergroup') {
      const chatId = normalizeSafeTelegramId(groupMessage.chat.id, true);
      if (
        !chatId ||
        !config.csService.groupMonitorForwardEnabled ||
        !config.csService.groupMonitorChatIds.includes(chatId)
      ) {
        return reply.send(ok({ ignored: true }));
      }
      const input = normalizeGroupMessage(groupMessage, Boolean(update.edited_message));
      if (!input) return reply.send(ok({ ignored: true }));
      try {
        await forwardGroupMessageToCs(input);
        return reply.send(ok({ ignored: false, forwarded: true }));
      } catch (error) {
        request.log.error({ err: error }, '[bot] group receipt forwarding failed');
        captureBackendException(error, request, 'bot.forward_group_cs');
        // CS 持久化前不可确认收件；Telegram 重投由 CS 的群/消息幂等键收敛。
        return reply
          .status(503)
          .send(fail('CS_UNAVAILABLE', 'Group message persistence unavailable'));
      }
    }

    // 群内 /start、频道和私聊编辑都不能进入现有一对一建档/客服链路。
    if (update.message?.chat?.type !== 'private') return reply.send(ok({ ignored: true }));
    const text = update.message?.text?.trim() ?? '';
    const startPayload = parseStartPayload(text);
    const tgId = normalizeTelegramId(update.message?.from?.id ?? update.message?.chat?.id);
    if (!tgId) {
      return reply.send(ok({ ignored: true }));
    }

    // 非 /start 的私聊消息全部交给独立客服服务（linshu368/ST_cs_platform）
    if (startPayload === undefined) {
      const photoFileId = pickPhotoFileId(update);
      const content = photoFileId ? (update.message?.caption?.trim() ?? '') : text;
      if (!content && !photoFileId) return reply.send(ok({ ignored: true }));
      // 转发失败也回 200：返回错误会让 Telegram 不断重投并卡住后面的 /start。
      // 客服服务按 message_id 去重，所以重复转发是安全的，丢失则靠 Sentry 发现。
      try {
        const user = await getOrCreateMiniappUserByTgId(tgId, null, false);
        await forwardBotMessageToCs({
          userId: user.id,
          telegramUserId: tgId,
          messageId: String(update.message?.message_id ?? ''),
          text: content,
          photoFileId,
          replyToMessageId: update.message?.reply_to_message?.message_id
            ? String(update.message.reply_to_message.message_id)
            : null,
        });
        return reply.send(ok({ ignored: false, forwarded: true }));
      } catch (error) {
        request.log.error({ err: error }, '[bot] forward to cs service failed');
        captureBackendException(error, request, 'bot.forward_cs', { tg_id: tgId });
        return reply.send(ok({ ignored: false, forwarded: false }));
      }
    }

    try {
      const user = await recordBotStart(tgId, startPayload);
      return reply.send(
        ok({
          ignored: false,
          user_id: user.id,
          tg_id: user.tg_id,
          bot_entered_at: user.bot_entered_at,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Telegram webhook failed';
      return reply.status(500).send(fail('INTERNAL_ERROR', message));
    }
  });
}

function normalizeSafeTelegramId(value: unknown, allowNegative = false): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) return null;
  return value > 0 || allowNegative ? String(value) : null;
}

function telegramTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeGroupMessage(
  message: TelegramWebhookMessage,
  edited: boolean
): TelegramGroupMessageInput | null {
  const chatId = normalizeSafeTelegramId(message.chat?.id, true);
  const messageId = normalizeSafeTelegramId(message.message_id);
  const sentAt = telegramTimestamp(message.date);
  const editedAt = edited ? telegramTimestamp(message.edit_date) : null;
  const photoFileId = pickPhotoFileId({ message });
  const text = normalizeNullableText(message.text ?? message.caption, 4_000) ?? '';
  if (!chatId || !messageId || !sentAt || (edited && !editedAt) || (!text && !photoFileId))
    return null;
  const senderName = message.sender_chat
    ? normalizeNullableText(message.sender_chat.title, 200)
    : (normalizeNullableText(
        [message.from?.first_name, message.from?.last_name]
          .filter((value) => typeof value === 'string')
          .join(' '),
        200
      ) ?? normalizeNullableText(message.from?.username, 200));
  return {
    bot_source: 'main',
    chat_id: chatId,
    chat_title: normalizeNullableText(message.chat?.title, 200) ?? undefined,
    message_id: messageId,
    telegram_user_id: message.sender_chat ? null : normalizeSafeTelegramId(message.from?.id),
    sender_name: senderName ?? '未知用户',
    is_bot: !message.sender_chat && message.from?.is_bot === true,
    text,
    sent_at: sentAt,
    reply_to_message_id: normalizeSafeTelegramId(message.reply_to_message?.message_id),
    photo_file_id: photoFileId,
    edited,
    edited_at: editedAt,
    sender_chat_id: normalizeSafeTelegramId(message.sender_chat?.id, true),
    message_thread_id: normalizeSafeTelegramId(message.message_thread_id),
  };
}

function normalizeTelegramId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function parseStartPayload(text: string): string | null | undefined {
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return undefined;
  return normalizeNullableText(match[1], 128);
}

/** 图片消息取最大尺寸；以文件发送的图片也算。其他文件（视频、文档）不转给客服 */
function pickPhotoFileId(update: TelegramWebhookUpdate): string | null {
  const message = update.message;
  const largest = Array.isArray(message?.photo) ? message.photo.at(-1)?.file_id : null;
  if (typeof largest === 'string' && largest) return largest;
  const document = message?.document;
  if (
    typeof document?.file_id === 'string' &&
    document.file_id &&
    /^image\/(jpeg|png|webp|gif)$/.test(document.mime_type ?? '')
  ) {
    return document.file_id;
  }
  return null;
}
