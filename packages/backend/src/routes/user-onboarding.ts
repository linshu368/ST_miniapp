import type { FastifyInstance } from 'fastify';
import { fail, ok, type UserOnboardingData } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUserRecord } from '../lib/user.js';

const DAY_MS = 24 * 60 * 60_000;

export function onboardingEligibility(
  createdAt: string,
  rounds: number,
  now = Date.now()
): UserOnboardingData {
  const created = Date.parse(createdAt);
  const age = now - created;
  // An empty browser cache is not evidence of a new account. Use server-owned history.
  const eligible = Number.isFinite(age) && age >= 0 && age < DAY_MS && rounds >= 0 && rounds < 10;
  return { eligible, expires_at: eligible ? new Date(created + 7 * DAY_MS).toISOString() : null };
}

export function registerUserOnboardingRoute(app: FastifyInstance): void {
  // @frontend-ready: true
  app.get(
    '/api/users/onboarding',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const started = Date.now();
      try {
        const user = await getOrCreateDbUserRecord(request.user);
        const data = onboardingEligibility(user.created_at, Number(user.total_round));
        request.log.debug(
          { eligible: data.eligible, duration_ms: Date.now() - started },
          'onboarding eligibility'
        );
        return reply.header('Cache-Control', 'private, no-store').send(ok(data));
      } catch (err) {
        request.log.warn(
          { err, duration_ms: Date.now() - started },
          'onboarding eligibility unavailable'
        );
        return reply.status(503).send(fail('ONBOARDING_UNAVAILABLE', '暂时无法读取引导状态'));
      }
    }
  );
}
