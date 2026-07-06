import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import { config } from '../platform/config.js';
import { recordBotStart } from '../lib/user.js';

interface BotStartRequestBody {
  tg_id?: unknown;
  source_id?: unknown;
}

interface TelegramWebhookUpdate {
  message?: {
    text?: string;
    from?: { id?: number };
    chat?: { id?: number };
  };
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
    const text = update.message?.text?.trim() ?? '';
    const startPayload = parseStartPayload(text);
    if (startPayload === null) {
      return reply.send(ok({ ignored: true }));
    }

    const tgId = normalizeTelegramId(update.message?.from?.id ?? update.message?.chat?.id);
    if (!tgId) {
      return reply.send(ok({ ignored: true }));
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

function parseStartPayload(text: string): string | null {
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  return normalizeNullableText(match[1], 128);
}
