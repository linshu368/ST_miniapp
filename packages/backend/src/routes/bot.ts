import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import { config } from '../platform/config.js';
import { getOrCreateMiniappUserByTgId, recordBotStart } from '../lib/user.js';
import { forwardBotMessageToCs, isCsServiceEnabled } from '../lib/cs-service.js';
import { captureBackendException } from '../lib/sentry.js';
import { CsPlatformRepository } from '../infrastructure/repositories/CsPlatformRepository.js';

interface BotStartRequestBody {
  tg_id?: unknown;
  source_id?: unknown;
}

interface TelegramWebhookUpdate {
  message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    /** 同一张图的多个尺寸，最后一个最大 */
    photo?: Array<{ file_id?: string }>;
    /** 用户「以文件发送」的截图会是 document */
    document?: { file_id?: string; mime_type?: string };
    from?: { id?: number };
    chat?: { id?: number };
    reply_to_message?: { message_id?: number };
  };
}

export default async function botRoutes(app: FastifyInstance) {
  const csRepository = new CsPlatformRepository();

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
    const text = update.message?.text?.trim() ?? '';
    const startPayload = parseStartPayload(text);
    const tgId = normalizeTelegramId(update.message?.from?.id ?? update.message?.chat?.id);
    if (!tgId) {
      return reply.send(ok({ ignored: true }));
    }

    if (startPayload === undefined && isCsServiceEnabled()) {
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

    if (startPayload === undefined) {
      let message = null;
      if (text) {
        try {
          message = await csRepository.receiveTelegramMessage({
            telegramUserId: tgId,
            content: text,
            telegramMessageId: update.message?.message_id
              ? String(update.message.message_id)
              : undefined,
          });
        } catch (error) {
          request.log.error({ err: error }, '[bot] receiveTelegramMessage failed');
        }
      }
      return reply.send(ok({ ignored: !message, cs_message_id: message?.id ?? null }));
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
  const largest = message?.photo?.at(-1)?.file_id;
  if (largest) return largest;
  const document = message?.document;
  if (document?.file_id && /^image\/(jpeg|png|webp|gif)$/.test(document.mime_type ?? '')) {
    return document.file_id;
  }
  return null;
}
