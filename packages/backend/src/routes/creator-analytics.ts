import type { FastifyInstance } from 'fastify';
import { CreatorAnalyticsQuerySchema, fail, ok } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { getCreatorAnalytics } from '../features/creator/analytics-repository.js';

export default async function creatorAnalyticsRoutes(app: FastifyInstance) {
  // @frontend-ready: true — creator-only aggregates; no private conversation data or player identities
  app.get(
    '/api/creator/analytics',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.user) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
      const parsed = CreatorAnalyticsQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send(fail('BAD_REQUEST', '筛选条件有误，请重新选择'));
      const started = performance.now();
      try {
        const owner = await getOrCreateDbUser(request.user);
        return reply.send(ok(await getCreatorAnalytics(owner.id, parsed.data)));
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'NOT_FOUND')
          return reply.code(404).send(fail('NOT_FOUND', '无法查看这张角色的数据'));
        request.log.error({ err, section: parsed.data.section }, 'creator analytics read failed');
        return reply
          .code(503)
          .send(fail('SERVICE_UNAVAILABLE', '暂时没能读取创作数据，请稍后重试'));
      } finally {
        request.log.info(
          {
            section: parsed.data.section,
            period: parsed.data.period,
            page: parsed.data.page,
            status: reply.statusCode,
            duration_ms: performance.now() - started,
          },
          'creator analytics read'
        );
      }
    }
  );
}
