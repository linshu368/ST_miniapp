import { FastifyInstance } from 'fastify';
import { fail, ok } from '@miniapp/shared';
import type { GetVipStatusData, MarkVipEntryViewedData } from '@miniapp/shared';

import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { readVipBenefits, VipStatusService } from '../features/vip/vip-status.js';

export default async function vipRoutes(app: FastifyInstance) {
  const vip = new VipStatusService();

  // @frontend-ready: true
  app.get('/api/vip/status', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const dbUser = await getOrCreateDbUser(request.user);
    const log = requestLogger(request.log, 'vip');
    const [status, benefits] = await Promise.all([
      vip.getStatus(dbUser.id, log),
      readVipBenefits(log),
    ]);
    return reply.send(ok<GetVipStatusData>({ ...status, benefits }));
  });

  // @frontend-ready: true
  app.post(
    '/api/vip/entry-viewed',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const dbUser = await getOrCreateDbUser(request.user);
      const log = requestLogger(request.log, 'vip');
      try {
        const [status, benefits] = await Promise.all([
          vip.markEntryViewed(dbUser.id, log),
          readVipBenefits(log),
        ]);
        return reply.send(ok<MarkVipEntryViewedData>({ ...status, benefits }));
      } catch (err) {
        log.sys.error(
          { err, event: 'vip.entry.view_failed', userId: dbUser.id },
          '标记 VIP 入口失败'
        );
        return reply.status(500).send(fail('VIP_ENTRY_VIEW_FAILED', '暂时无法记录 VIP 入口状态'));
      }
    }
  );
}
