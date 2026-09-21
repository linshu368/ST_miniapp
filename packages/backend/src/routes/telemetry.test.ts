import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wallets = {
  hasCompletedPayment: vi.fn(async () => false),
};

vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
  getDomainDb: () => ({}),
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: vi.fn(async () => ({
    id: '00000000-0000-0000-0000-000000000099',
    tg_id: '99999',
    total_round: 12,
  })),
}));

vi.mock('../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    constructor() {
      return wallets;
    }
  },
}));

async function buildApp() {
  const { default: telemetryRoutes } = await import('./telemetry.js');
  const app = Fastify({ logger: false });
  await app.register(telemetryRoutes);
  await app.ready();
  return app;
}

describe('GET /api/telemetry/replay-context', () => {
  beforeEach(() => {
    wallets.hasCompletedPayment.mockReset();
    wallets.hasCompletedPayment.mockResolvedValue(true);
    vi.stubEnv('DEV_AUTH_BYPASS', '');
    vi.stubEnv('MOCK_AUTH', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects missing Telegram auth', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/telemetry/replay-context',
      });
      expect(response.statusCode).toBe(401);
      const body = response.json() as { success: boolean };
      expect(body.success).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns only GetReplayContextData for an authenticated user', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/telemetry/replay-context',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        success: boolean;
        data: Record<string, unknown>;
      };
      expect(body).toEqual({
        success: true,
        data: {
          telegram_user_id: '99999',
          is_paid_user: true,
          total_chat_rounds: 12,
        },
      });
      expect(body.data).not.toHaveProperty('user_id');
      expect(body.data).not.toHaveProperty('user_cohort');
      expect(body.data).not.toHaveProperty('id');
    } finally {
      await app.close();
    }
  });
});
