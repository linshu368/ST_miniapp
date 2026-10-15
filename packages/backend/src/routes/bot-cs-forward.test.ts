import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'webhook-secret';
const USER_ID = '00000000-0000-4000-8000-000000000042';

const mocks = vi.hoisted(() => ({
  enabled: true,
  forwardBotMessageToCs: vi.fn(),
  getOrCreateMiniappUserByTgId: vi.fn(),
  recordBotStart: vi.fn(),
  receiveTelegramMessage: vi.fn(),
  captureBackendException: vi.fn(),
}));

vi.mock('../platform/config.js', () => ({
  config: { telegramWebhookSecret: 'webhook-secret', botInternalSecret: 'internal' },
}));
vi.mock('../lib/cs-service.js', () => ({
  isCsServiceEnabled: () => mocks.enabled,
  forwardBotMessageToCs: mocks.forwardBotMessageToCs,
}));
vi.mock('../lib/user.js', () => ({
  getOrCreateMiniappUserByTgId: mocks.getOrCreateMiniappUserByTgId,
  recordBotStart: mocks.recordBotStart,
}));
vi.mock('../lib/sentry.js', () => ({ captureBackendException: mocks.captureBackendException }));
vi.mock('../infrastructure/repositories/CsPlatformRepository.js', () => ({
  CsPlatformRepository: class {
    receiveTelegramMessage = mocks.receiveTelegramMessage;
  },
}));

async function buildApp() {
  const { default: botRoutes } = await import('./bot.js');
  const app = Fastify({ logger: false });
  await app.register(botRoutes);
  await app.ready();
  return app;
}

const update = (text: string) => ({
  message: {
    message_id: 77,
    text,
    from: { id: 123456 },
    chat: { id: 123456 },
    reply_to_message: { message_id: 70 },
  },
});

const post = (app: Awaited<ReturnType<typeof buildApp>>, text: string) =>
  app.inject({
    method: 'POST',
    url: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    payload: update(text),
  });

describe('bot webhook → cs service', () => {
  beforeEach(() => {
    mocks.enabled = true;
    for (const fn of [
      mocks.forwardBotMessageToCs,
      mocks.getOrCreateMiniappUserByTgId,
      mocks.recordBotStart,
      mocks.receiveTelegramMessage,
      mocks.captureBackendException,
    ])
      fn.mockReset();
    mocks.getOrCreateMiniappUserByTgId.mockResolvedValue({ id: USER_ID });
    mocks.recordBotStart.mockResolvedValue({ id: USER_ID, tg_id: '123456', bot_entered_at: null });
  });

  it('普通文本：补建用户后转发，不碰旧回访表', async () => {
    const app = await buildApp();
    try {
      const response = await post(app, '充值没到账');
      expect(response.json()).toEqual({ success: true, data: { ignored: false, forwarded: true } });
      expect(mocks.getOrCreateMiniappUserByTgId).toHaveBeenCalledWith('123456', null, false);
      expect(mocks.forwardBotMessageToCs).toHaveBeenCalledWith({
        userId: USER_ID,
        telegramUserId: '123456',
        messageId: '77',
        text: '充值没到账',
        replyToMessageId: '70',
      });
      expect(mocks.receiveTelegramMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('/start 仍由本服务建档，不转发', async () => {
    const app = await buildApp();
    try {
      await post(app, '/start src_1');
      expect(mocks.recordBotStart).toHaveBeenCalledWith('123456', 'src_1');
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('转发失败仍回 200，避免 Telegram 重投卡住后续更新，并上报 Sentry', async () => {
    mocks.forwardBotMessageToCs.mockRejectedValue(new Error('timeout'));
    const app = await buildApp();
    try {
      const response = await post(app, '在吗');
      expect(response.statusCode).toBe(200);
      expect(response.json().data.forwarded).toBe(false);
      expect(mocks.captureBackendException).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('开关关闭时走旧回访入库', async () => {
    mocks.enabled = false;
    mocks.receiveTelegramMessage.mockResolvedValue({ id: 'old-1' });
    const app = await buildApp();
    try {
      await post(app, '在吗');
      expect(mocks.receiveTelegramMessage).toHaveBeenCalledOnce();
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
