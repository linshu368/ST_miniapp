/**
 * backend / routes / alerts.ts
 *
 * POST /api/alerts/sentry —— Sentry Alert 的 webhook 入口。
 *
 * 只负责鉴权和转换，投递仍走 features/alerting/ 的 outbox + delivery worker，
 * 所以 Sentry 侧超时不会卡住请求，也不会因为飞书故障丢告警。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { config } from '../platform/config.js';
import { convertSentryAlert } from '../features/alerting/sentry-bridge.js';
import { AlertPublisher } from '../features/alerting/publisher.js';
import { PrismaAlertPersistence } from '../features/alerting/repository.js';
import { createLogger } from '../lib/logger.js';

const ALERT_SECRET_HEADER = 'x-alert-secret';

function secretMatches(provided: string | undefined): boolean {
  const expected = config.alerting.sentryWebhookSecret;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * evaluation_id 必须对同一 payload 稳定（webhook 会重投），否则去重失效会重复推送。
 */
function stableRunId(payload: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  // 取前 32 位拼成合法 UUID 形状，满足共享契约的 uuid 校验。
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export default async function alertRoutes(app: FastifyInstance) {
  const publisher = new AlertPublisher(new PrismaAlertPersistence(), createLogger('alert'));

  // @frontend-ready: false
  app.post('/api/alerts/sentry', async (request, reply) => {
    if (!secretMatches(request.headers[ALERT_SECRET_HEADER] as string | undefined)) {
      return reply.status(401).send({ ok: false, error: 'unauthorized' });
    }

    const converted = convertSentryAlert(request.body, {
      producerRunId: stableRunId(request.body ?? randomUUID()),
      environment: config.nodeEnv === 'production' ? 'production' : 'development',
    });

    if (converted.kind === 'ignored') {
      // 非告警类 payload 直接确认，避免 Sentry 重试。
      return reply.send({ ok: true, ignored: converted.reason });
    }

    const result = await publisher.publish(converted.evaluation);
    request.log.info(
      {
        event: 'alert.sentry.relay',
        result: result.kind,
        fingerprint: converted.evaluation.fingerprint,
      },
      'Sentry 告警已转发'
    );
    return reply.send({ ok: result.kind !== 'failed', result: result.kind });
  });
}
