import type { FastifyInstance } from 'fastify';
import { ok, fail, RelayProviderSchema, SurplusModelIdSchema } from '@miniapp/shared';
import { authorizeAdminOperator } from '../features/admin-access/session.js';
import { getRelayBalance } from '../platform/relay-provider-balance.js';
import { requestLogger } from '../lib/logger.js';
import { SurplusMarketError } from '../features/free-zone/surplus-market.js';
import { loadSurplusProviderMarket } from '../features/generation/surplus-provider-market.js';

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

  // @frontend-ready: true（运营平台「模型供应商路由」的 Surplus 规则：查某模型各供应商报价与 24h 表现）
  app.get('/api/admin/model-providers/:provider/market', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
    reply.header('Cache-Control', 'private, no-store');
    const provider = (request.params as { provider: string }).provider;
    if (provider !== 'surplus')
      return reply.status(400).send(fail('INVALID_PROVIDER', 'Only Surplus has a market book'));
    const model = SurplusModelIdSchema.safeParse((request.query as { model?: unknown }).model);
    if (!model.success) return reply.status(400).send(fail('BAD_REQUEST', '参数不合法：model'));
    const log = requestLogger(request.log, 'generation');
    const started = performance.now();
    try {
      const market = await loadSurplusProviderMarket(model.data);
      log.biz[market.performance_status === 'ok' ? 'info' : 'warn'](
        {
          event: 'provider.market_probe_completed',
          provider,
          model: model.data,
          outcome: market.performance_status === 'ok' ? 'succeeded' : 'degraded',
          providerCount: market.providers.length,
          performanceStatus: market.performance_status,
          durationMs: performance.now() - started,
        },
        'Surplus 报价查询完成'
      );
      return reply.send(ok(market));
    } catch (err) {
      const upstreamStatus = err instanceof SurplusMarketError ? err.status : null;
      log.biz.warn(
        {
          event: 'provider.market_probe_completed',
          provider,
          model: model.data,
          outcome: 'failed',
          code: upstreamStatus === null ? 'unreachable' : `http_${upstreamStatus}`,
          upstreamStatus,
          durationMs: performance.now() - started,
          err,
        },
        'Surplus 报价查询失败'
      );
      return reply
        .status(502)
        .send(fail('UPSTREAM_UNAVAILABLE', 'Surplus 报价暂时读不到，稍后再试'));
    }
  });
}
