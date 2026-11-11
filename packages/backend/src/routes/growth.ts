import type { FastifyInstance } from 'fastify';
import { fail, ok } from '@miniapp/shared';
import { verifyTelegramInitData } from '../middleware/auth.js';
import { recordEntry } from '../features/growth/entry.js';

export default async function growthRoutes(app: FastifyInstance) {
  for (const surface of ['mujian', 'mijing'] as const) {
    const path = surface === 'mujian' ? '/api/growth/mujian-entry' : '/api/growth/miniapp-entry';
    // @frontend-ready: true — both clients report entry; no private-message permission is requested.
    app.post(path, async (request, reply) => {
      const raw = request.headers['x-init-data'];
      let user;
      try {
        if (typeof raw !== 'string') throw new Error('Missing Telegram identity');
        user = verifyTelegramInitData(raw, false);
      } catch {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Telegram 身份无效或已过期'));
      }
      const params = new URLSearchParams(raw);
      const launch = params.get('start_param');
      const source = launch && /^[A-Za-z0-9_-]{3,64}$/.test(launch) ? launch : null;
      try {
        const data = await recordEntry(
          String(user.id),
          surface,
          source,
          Number(params.get('auth_date'))
        );
        request.log.info({ surface, recorded: data.recorded }, 'growth entry persisted');
        return reply.header('Cache-Control', 'private, no-store').send(ok(data));
      } catch {
        // Database errors may contain SQL parameter values. Keep this event free of launch credentials.
        request.log.error(
          { surface, event: 'growth.entry_failed' },
          'growth entry persistence failed'
        );
        return reply.status(503).send(fail('ENTRY_UNAVAILABLE', '进入记录暂不可用，请稍后重试'));
      }
    });
  }
}
