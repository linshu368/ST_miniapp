import type { FastifyInstance } from 'fastify';
import { ok, fail, RelayProviderSchema } from '@miniapp/shared';
import { authorizeAdminOperator } from '../features/admin-access/session.js';
import { getRelayBalance } from '../platform/relay-provider-balance.js';
import { requestLogger } from '../lib/logger.js';

export default async function adminModelProviderRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/admin/model-providers/:provider/balance', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
    reply.header('Cache-Control', 'private, no-store');
    const parsed = RelayProviderSchema.safeParse((request.params as { provider: string }).provider);
    if (!parsed.success)
      return reply.status(400).send(fail('INVALID_PROVIDER', 'Unsupported balance provider'));
    const started = performance.now();
    const result = await getRelayBalance(
      parsed.data,
      (request.query as { refresh?: string }).refresh === '1'
    );
    const log = requestLogger(request.log, 'generation');
    log.biz.info(
      {
        event: 'provider.balance_probe_completed',
        provider: parsed.data,
        outcome: result.status,
        code: result.error_code,
        durationMs: performance.now() - started,
      },
      '供应商余额查询完成'
    );
    return reply.send(ok(result));
  });
}
