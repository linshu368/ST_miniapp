import Fastify, { type FastifyRequest } from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { UserOnboardingSchema } from '@miniapp/shared';

const user = vi.hoisted(() => vi.fn());
vi.mock('../lib/user.js', () => ({ getOrCreateDbUserRecord: user }));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    if (request.headers['x-test-auth']) request.user = { id: 123, first_name: 'Preview' };
  },
}));
import { onboardingEligibility, registerUserOnboardingRoute } from './user-onboarding.js';

describe('onboarding is optional and only for server-confirmed newcomers', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  it('uses age and actual rounds, never an empty browser cache', () => {
    expect(onboardingEligibility('2026-11-06T09:00:00Z', 0, now)).toEqual({
      eligible: true,
      expires_at: '2026-11-13T09:00:00.000Z',
    });
    for (const [date, rounds] of [
      ['2026-11-05T10:00:00Z', 0],
      ['2026-11-06T09:00:00Z', 10],
      ['invalid', 0],
      ['2026-11-07T09:00:00Z', 0],
    ] as const)
      expect(onboardingEligibility(date, rounds, now).eligible).toBe(false);
  });
  it('requires auth and handles read failure without leaking details', async () => {
    const app = Fastify();
    registerUserOnboardingRoute(app);
    expect((await app.inject('/api/users/onboarding')).statusCode).toBe(401);
    user.mockRejectedValueOnce(new Error('private detail'));
    const failed = await app.inject({
      url: '/api/users/onboarding',
      headers: { 'x-test-auth': 'yes' },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('private detail');
    user.mockResolvedValueOnce({ created_at: new Date().toISOString(), total_round: 0 });
    const ok = await app.inject({
      url: '/api/users/onboarding',
      headers: { 'x-test-auth': 'yes' },
    });
    expect(ok.statusCode).toBe(200);
    expect(UserOnboardingSchema.parse(ok.json().data).eligible).toBe(true);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });
});
