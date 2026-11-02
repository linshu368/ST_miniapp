import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'webhook-secret';
const USER_ID = '00000000-0000-4000-8000-000000000042';

const mocks = vi.hoisted(() => ({
  forwardBotMessageToCs: vi.fn(),
  forwardGroupMessageToCs: vi.fn(),
  getOrCreateMiniappUserByTgId: vi.fn(),
  recordBotStart: vi.fn(),
  captureBackendException: vi.fn(),
  csService: { groupMonitorForwardEnabled: false, groupMonitorChatIds: [] as string[] },
}));

vi.mock('../platform/config.js', () => ({
  config: {
    telegramWebhookSecret: 'webhook-secret',
    botInternalSecret: 'internal',
    csService: mocks.csService,
  },
}));
vi.mock('../lib/cs-service.js', () => ({
  forwardBotMessageToCs: mocks.forwardBotMessageToCs,
  forwardGroupMessageToCs: mocks.forwardGroupMessageToCs,
}));
vi.mock('../lib/user.js', () => ({
  getOrCreateMiniappUserByTgId: mocks.getOrCreateMiniappUserByTgId,
  recordBotStart: mocks.recordBotStart,
}));
vi.mock('../lib/sentry.js', () => ({ captureBackendException: mocks.captureBackendException }));

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
    chat: { id: 123456, type: 'private' },
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
    for (const fn of [
      mocks.forwardBotMessageToCs,
      mocks.forwardGroupMessageToCs,
      mocks.getOrCreateMiniappUserByTgId,
      mocks.recordBotStart,
      mocks.captureBackendException,
    ])
      fn.mockReset();
    mocks.csService.groupMonitorForwardEnabled = false;
    mocks.csService.groupMonitorChatIds = [];
    mocks.getOrCreateMiniappUserByTgId.mockResolvedValue({ id: USER_ID });
    mocks.recordBotStart.mockResolvedValue({ id: USER_ID, tg_id: '123456', bot_entered_at: null });
  });

  it('普通文本：补建用户后转发', async () => {
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
        photoFileId: null,
        replyToMessageId: '70',
      });
    } finally {
      await app.close();
    }
  });

  it('图片：取最大尺寸的 file_id，说明文字当正文；以文件发送的截图也转；视频不转', async () => {
    const app = await buildApp();
    const send = (message: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: {
          message: {
            message_id: 78,
            from: { id: 123456 },
            chat: { id: 123456, type: 'private' },
            ...message,
          },
        },
      });
    try {
      await send({ photo: [{ file_id: 'small' }, { file_id: 'large' }], caption: ' 报错了 ' });
      expect(mocks.forwardBotMessageToCs).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: '报错了', photoFileId: 'large' })
      );
      await send({ document: { file_id: 'doc', mime_type: 'image/png' } });
      expect(mocks.forwardBotMessageToCs).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: '', photoFileId: 'doc' })
      );
      const video = await send({ document: { file_id: 'v', mime_type: 'video/mp4' } });
      expect(video.json()).toEqual({ success: true, data: { ignored: true } });
      expect(mocks.forwardBotMessageToCs).toHaveBeenCalledTimes(2);
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

  const groupMessage = (extra: Record<string, unknown> = {}) => ({
    message_id: 77,
    date: 1_792_627_200,
    text: '充值未到账',
    from: { id: 123456, first_name: 'Test', last_name: 'User', is_bot: false },
    chat: { id: -1001234567890, type: 'supergroup', title: 'Test support group' },
    reply_to_message: { message_id: 70 },
    ...extra,
  });

  const postUpdate = (
    app: Awaited<ReturnType<typeof buildApp>>,
    payload: Record<string, unknown>
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload,
    });

  it('群消息默认关闭；开关开启仍需要非空且匹配的白名单，群内 /start 从不建档', async () => {
    const app = await buildApp();
    try {
      await postUpdate(app, { message: groupMessage({ text: '/start group_test' }) });
      mocks.csService.groupMonitorForwardEnabled = true;
      await postUpdate(app, { message: groupMessage() });
      mocks.csService.groupMonitorChatIds = ['-999'];
      await postUpdate(app, { message: groupMessage() });
      expect(mocks.forwardGroupMessageToCs).not.toHaveBeenCalled();
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
      expect(mocks.getOrCreateMiniappUserByTgId).not.toHaveBeenCalled();
      expect(mocks.recordBotStart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('允许群的图片、作者、topic 与回复只转发到独立收件入口', async () => {
    const app = await buildApp();
    mocks.csService.groupMonitorForwardEnabled = true;
    mocks.csService.groupMonitorChatIds = ['-1001234567890'];
    try {
      const response = await postUpdate(app, {
        message: groupMessage({
          text: undefined,
          caption: '  图片报错  ',
          photo: [{ file_id: 'small' }, { file_id: 'large' }],
          message_thread_id: 8,
        }),
      });
      expect(response.json().data.forwarded).toBe(true);
      expect(mocks.forwardGroupMessageToCs).toHaveBeenCalledWith({
        bot_source: 'main',
        chat_id: '-1001234567890',
        chat_title: 'Test support group',
        message_id: '77',
        telegram_user_id: '123456',
        sender_name: 'Test User',
        is_bot: false,
        text: '图片报错',
        sent_at: new Date(1_792_627_200_000).toISOString(),
        reply_to_message_id: '70',
        photo_file_id: 'large',
        edited: false,
        edited_at: null,
        sender_chat_id: null,
        message_thread_id: '8',
      });
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
      expect(mocks.getOrCreateMiniappUserByTgId).not.toHaveBeenCalled();
      expect(mocks.recordBotStart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('群编辑沿用消息 ID 并携带 edited_at；匿名管理员不使用假的 from 用户', async () => {
    const app = await buildApp();
    mocks.csService.groupMonitorForwardEnabled = true;
    mocks.csService.groupMonitorChatIds = ['-1001234567890'];
    try {
      await postUpdate(app, {
        edited_message: groupMessage({
          edit_date: 1_792_627_260,
          sender_chat: { id: -1001234567890, title: 'Anonymous admin' },
        }),
      });
      expect(mocks.forwardGroupMessageToCs).toHaveBeenCalledWith(
        expect.objectContaining({
          message_id: '77',
          edited: true,
          edited_at: new Date(1_792_627_260_000).toISOString(),
          telegram_user_id: null,
          sender_chat_id: '-1001234567890',
          sender_name: 'Anonymous admin',
        })
      );
    } finally {
      await app.close();
    }
  });

  it('已允许群的 /start 仍只进群收件；长消息符合客服收件长度上限', async () => {
    const app = await buildApp();
    mocks.csService.groupMonitorForwardEnabled = true;
    mocks.csService.groupMonitorChatIds = ['-1001234567890'];
    try {
      await postUpdate(app, { message: groupMessage({ text: '/start group_test' }) });
      expect(mocks.forwardGroupMessageToCs).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: '/start group_test' })
      );
      await postUpdate(app, { message: groupMessage({ text: 'a'.repeat(4_096) }) });
      expect(mocks.forwardGroupMessageToCs).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'a'.repeat(4_000) })
      );
      expect(mocks.recordBotStart).not.toHaveBeenCalled();
      expect(mocks.getOrCreateMiniappUserByTgId).not.toHaveBeenCalled();
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('已允许群收件失败返回 503 以便重投，不吞掉失败', async () => {
    const app = await buildApp();
    mocks.csService.groupMonitorForwardEnabled = true;
    mocks.csService.groupMonitorChatIds = ['-1001234567890'];
    mocks.forwardGroupMessageToCs.mockRejectedValue(new Error('timeout'));
    try {
      const response = await postUpdate(app, { message: groupMessage() });
      expect(response.statusCode).toBe(503);
      expect(mocks.captureBackendException).toHaveBeenCalledOnce();
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('无效群消息、频道和私聊编辑不能进入任一收件链路', async () => {
    const app = await buildApp();
    mocks.csService.groupMonitorForwardEnabled = true;
    mocks.csService.groupMonitorChatIds = ['-1001234567890'];
    try {
      for (const payload of [
        { message: groupMessage({ message_id: 0 }) },
        { message: groupMessage({ message_id: Number.MAX_SAFE_INTEGER + 1 }) },
        { message: groupMessage({ date: -1 }) },
        { message: groupMessage({ date: Number.MAX_SAFE_INTEGER }) },
        { edited_message: groupMessage({ edit_date: 0 }) },
        { message: groupMessage({ chat: { id: -1001234567890, type: 'channel' } }) },
        { edited_message: update('私聊编辑').message },
      ]) {
        expect((await postUpdate(app, payload)).json().data.ignored).toBe(true);
      }
      expect(mocks.forwardGroupMessageToCs).not.toHaveBeenCalled();
      expect(mocks.forwardBotMessageToCs).not.toHaveBeenCalled();
      expect(mocks.getOrCreateMiniappUserByTgId).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
