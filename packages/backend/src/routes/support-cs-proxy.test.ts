import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = '00000000-0000-4000-8000-000000000099';
const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';

const cs = vi.hoisted(() => ({
  enabled: true,
  callCsService: vi.fn(),
}));

vi.mock('../lib/cs-service.js', () => ({
  isCsServiceEnabled: () => cs.enabled,
  callCsService: cs.callCsService,
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: vi.fn(async () => ({ id: ME })),
}));

const getDomainDb = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
  getDomainDb,
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
    cs.enabled = true;
    cs.callCsService.mockReset();
    getDomainDb.mockReset();
  });

  it('开关打开时按用户转发，状态码和信封原样透传，不再读旧表', async () => {
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
        }
      );
      expect(getDomainDb).not.toHaveBeenCalled();
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

  it('开关关闭时走旧逻辑', async () => {
    cs.enabled = false;
    getDomainDb.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    });
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/support/conversation' });
      expect(response.json()).toEqual({ success: true, data: { conversation: null } });
      expect(cs.callCsService).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
