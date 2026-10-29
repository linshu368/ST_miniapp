import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = '00000000-0000-4000-8000-000000000099';
const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';

const cs = vi.hoisted(() => ({
  callCsService: vi.fn(),
}));
const logs = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../lib/cs-service.js', () => ({
  CS_SERVICE_IMAGE_TIMEOUT_MS: 20_000,
  callCsService: cs.callCsService,
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: vi.fn(async () => ({ id: ME })),
}));

vi.mock('../lib/logger.js', () => ({
  requestLogger: () => ({
    biz: { info: logs.info },
    sys: { error: logs.error },
  }),
}));

async function buildApp() {
  const { default: supportRoutes } = await import('./support.js');
  const app = Fastify({ logger: false });
  await app.register(supportRoutes);
  await app.ready();
  return app;
}

describe('support routes → cs service proxy', () => {
  beforeEach(() => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    cs.callCsService.mockReset();
    logs.info.mockReset();
    logs.error.mockReset();
  });

  it('按用户转发，状态码和信封原样透传', async () => {
    cs.callCsService.mockImplementation(async (method: string, path: string) => ({
      status: method === 'POST' && path.endsWith('/messages') ? 201 : 200,
      payload: { success: true, data: { path } },
    }));
    const app = await buildApp();
    try {
      const cases: Array<[string, string, unknown, string, number]> = [
        [
          'GET',
          '/api/support/conversation',
          undefined,
          `/internal/app/users/${ME}/conversation`,
          200,
        ],
        ['GET', '/api/support/unread', undefined, `/internal/app/users/${ME}/unread`, 200],
        ['POST', '/api/support/read', undefined, `/internal/app/users/${ME}/read`, 200],
        [
          'GET',
          '/api/support/messages?after=2026-10-15T08:03:10.223125Z',
          undefined,
          `/internal/app/users/${ME}/messages?after=2026-10-15T08%3A03%3A10.223125Z`,
          200,
        ],
        [
          'POST',
          '/api/support/messages',
          { body: ' 你好 ', client_msg_id: CLIENT_ID },
          `/internal/app/users/${ME}/messages`,
          201,
        ],
      ];
      for (const [method, url, payload, expectedPath, expectedStatus] of cases) {
        const response = await app.inject({
          method: method as 'GET' | 'POST',
          url,
          payload: payload as never,
        });
        expect(response.statusCode).toBe(expectedStatus);
        expect(response.json()).toEqual({ success: true, data: { path: expectedPath } });
      }
      expect(cs.callCsService).toHaveBeenLastCalledWith(
        'POST',
        `/internal/app/users/${ME}/messages`,
        {
          body: '你好',
          client_msg_id: CLIENT_ID,
        },
        undefined
      );
      expect(logs.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'support.proxy.completed',
          operation: 'messages.send',
          status: 201,
          identityMs: expect.any(Number),
          upstreamMs: expect.any(Number),
          totalMs: expect.any(Number),
        }),
        '客服代理请求完成'
      );
    } finally {
      await app.close();
    }
  });

  it('只发图片：图片原样转给客服服务并放宽超时；图片不是 base64 就拦下', async () => {
    cs.callCsService.mockResolvedValue({ status: 201, payload: { success: true, data: {} } });
    const app = await buildApp();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/support/messages',
        payload: { body: '', client_msg_id: CLIENT_ID, image: { data_base64: 'iVBORw0KGgo=' } },
      });
      expect(ok.statusCode).toBe(201);
      expect(cs.callCsService).toHaveBeenLastCalledWith(
        'POST',
        `/internal/app/users/${ME}/messages`,
        { body: '', client_msg_id: CLIENT_ID, image: { data_base64: 'iVBORw0KGgo=' } },
        20_000
      );

      const bad = await app.inject({
        method: 'POST',
        url: '/api/support/messages',
        payload: {
          body: '',
          client_msg_id: CLIENT_ID,
          image: { data_base64: 'data:image/png;base64,xx' },
        },
      });
      expect(bad.statusCode).toBe(400);
      expect(cs.callCsService).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('非法消息仍在本服务拦下，不打到客服服务', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/support/messages',
        payload: { body: '你好', client_msg_id: 'not-a-uuid' },
      });
      expect(response.statusCode).toBe(400);
      expect(cs.callCsService).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('上游失败保留原始错误对象并只记录安全的耗时上下文', async () => {
    const upstreamError = new Error('cs unavailable');
    cs.callCsService.mockRejectedValue(upstreamError);
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/support/unread' });
      expect(response.statusCode).toBe(500);
      expect(logs.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: upstreamError,
          event: 'support.proxy.failed',
          operation: 'unread',
          identityMs: expect.any(Number),
          totalMs: expect.any(Number),
        }),
        '客服代理请求失败'
      );
      expect(logs.error.mock.calls[0]?.[0]).not.toHaveProperty('path');
      expect(logs.error.mock.calls[0]?.[0]).not.toHaveProperty('userId');
    } finally {
      await app.close();
    }
  });
});
