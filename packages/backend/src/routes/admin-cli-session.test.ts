import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const userId = '20000000-0000-4000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  allowedEmails: [] as string[],
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
  createClient: vi.fn(),
  loadAdminActor: vi.fn(),
}));

vi.mock('../platform/config.js', () => ({
  config: {
    adminCli: {
      get allowedEmails() {
        return mocks.allowedEmails;
      },
    },
    supabase: { url: 'https://project.supabase.invalid', serviceRoleKey: 'service-role' },
  },
}));
vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ auth: { admin: { generateLink: mocks.generateLink } } }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../features/admin-access/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/admin-access/session.js')>()),
  loadAdminActor: mocks.loadAdminActor,
}));

import routes, { resetAdminCliSessionRateLimit } from './admin-cli-session.js';
import { AdminSessionError } from '../features/admin-access/session.js';

beforeEach(() => {
  vi.resetAllMocks();
  resetAdminCliSessionRateLimit();
  mocks.allowedEmails = ['owner@example.com'];
  mocks.generateLink.mockResolvedValue({
    data: { properties: { hashed_token: 'hash' }, user: { id: userId } },
    error: null,
  });
  mocks.loadAdminActor.mockResolvedValue({ userId, role: 'owner' });
  mocks.createClient.mockReturnValue({ auth: { verifyOtp: mocks.verifyOtp } });
  mocks.verifyOtp.mockResolvedValue({
    data: {
      session: { access_token: 'access', refresh_token: 'refresh', expires_at: 1_900_000_000 },
    },
    error: null,
  });
});

async function login(email: string) {
  const app = Fastify();
  await app.register(routes);
  try {
    return await app.inject({ method: 'POST', url: '/api/admin/cli/session', payload: { email } });
  } finally {
    await app.close();
  }
}

describe('POST /api/admin/cli/session', () => {
  it('白名单为空时接口关闭', async () => {
    mocks.allowedEmails = [];
    expect((await login('owner@example.com')).statusCode).toBe(404);
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });

  it('不在白名单的邮箱被拒绝，且不生成任何凭据', async () => {
    expect((await login('someone@example.com')).statusCode).toBe(403);
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });

  it('白名单邮箱（大小写不敏感）签发该账号的会话', async () => {
    const response = await login('Owner@Example.com');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: 1_900_000_000,
        user_id: userId,
      },
    });
    expect(mocks.generateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: 'owner@example.com',
    });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash', type: 'magiclink' });
  });

  it('不是当前环境运营账号时不兑换会话', async () => {
    mocks.loadAdminActor.mockRejectedValue(
      new AdminSessionError(403, 'Admin read access is required')
    );
    expect((await login('owner@example.com')).statusCode).toBe(403);
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it('短时间内签发次数超限后返回 429', async () => {
    for (let i = 0; i < 20; i += 1) expect((await login('owner@example.com')).statusCode).toBe(200);
    expect((await login('owner@example.com')).statusCode).toBe(429);
  });
});
