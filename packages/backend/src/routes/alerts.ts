/**
 * backend / routes / alerts.ts
 *
 * POST /api/alerts/sentry —— Sentry Alert 的 webhook 入口。
 *
 * 只负责鉴权和转换，投递仍走 features/alerting/ 的 outbox + delivery worker，
 * 所以 Sentry 侧超时不会卡住请求，也不会因为飞书故障丢告警。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { config } from '../platform/config.js';
import { convertSentryAlert } from '../features/alerting/sentry-bridge.js';
import { AlertPublisher } from '../features/alerting/publisher.js';
import { PrismaAlertPersistence } from '../features/alerting/repository.js';
import { createLogger } from '../lib/logger.js';

const ALERT_SECRET_HEADER = 'x-alert-secret';
/** Internal Integration 每次投递都会带上它，签名是 body 的 HMAC-SHA256。 */
const SENTRY_SIGNATURE_HEADER = 'sentry-hook-signature';
/** 原始 body 只对本路由生效：验签需要字节级原文，解析后的对象无法还原空白与键序。 */
const RAW_JSON = 'sentry-webhook-raw-json';

function secretMatches(provided: string | undefined): boolean {
  const expected = config.alerting.sentryWebhookSecret;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Internal Integration 的 Webhook URL 字段只能填一个完整 URL，不能加自定义 header，
 * 所以配置时把共享密钥放进了 query string（?token=...）。和 header 版共用同一个密钥，
 * 校验逻辑完全一致，只是取值位置不同。
 */
function queryTokenMatches(request: FastifyRequest): boolean {
  const provided = (request.query as Record<string, unknown> | undefined)?.token;
  return typeof provided === 'string' && secretMatches(provided);
}

/**
 * Sentry 用 `client secret` 对整段 body 做 HMAC-SHA256，以十六进制放在
 * sentry-hook-signature 里。没配 client secret 时不做签名校验（但共享密钥仍然必需）。
 */
function signatureMatches(request: FastifyRequest): boolean {
  const clientSecret = config.alerting.sentryClientSecret;
  const provided = request.headers[SENTRY_SIGNATURE_HEADER] as string | undefined;
  if (!clientSecret) return false;
  if (!provided) return false;
  const raw = (request as { rawBody?: string }).rawBody;
  if (typeof raw !== 'string') return false;
  const expected = createHmac('sha256', clientSecret).update(raw).digest('hex');
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

  // 只在本插件作用域内替换 JSON 解析器，其他路由不受影响。
  // 默认解析器会丢掉原始字节，验签就无从算起。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      // 畸形 JSON 交给下面的转换层降级处理，不在这里 400——避免对方重试风暴。
      done(null, null);
    }
  });

  // @frontend-ready: false
  app.post('/api/alerts/sentry', async (request, reply) => {
    // 三种凭据任一成立即可：Sentry 签名（主）、webhook URL 里的 ?token=（Sentry
    // Internal Integration 不支持自定义 header，只能靠 URL 带密钥）、共享密钥头
    // （手工 curl 调试用）。全部不成立时一律 401，包括三个都没配置的情况。
    const signed = signatureMatches(request);
    const queryToken = queryTokenMatches(request);
    const shared = secretMatches(request.headers[ALERT_SECRET_HEADER] as string | undefined);
    if (!signed && !queryToken && !shared) {
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
