import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const SECRET = 'shared-secret';
const CLIENT_SECRET = 'client-secret';

const mocks = vi.hoisted(() => ({
  publish: vi.fn<(evaluation: unknown) => Promise<{ kind: 'accepted' }>>(async () => ({
    kind: 'accepted' as const,
  })),
}));

vi.mock('../platform/config.js', () => ({
  config: {
    nodeEnv: 'production',
    alerting: {
      sentryWebhookSecret: 'shared-secret',
      sentryClientSecret: 'client-secret',
    },
  },
}));
vi.mock('../features/alerting/publisher.js', () => ({
  AlertPublisher: class {
    publish = mocks.publish;
  },
}));
vi.mock('../features/alerting/repository.js', () => ({
  PrismaAlertPersistence: class {},
}));
vi.mock('../lib/logger.js', () => ({
  createLogger: () => ({
    biz: { info: vi.fn(), warn: vi.fn() },
    sys: { info: vi.fn(), warn: vi.fn() },
  }),
}));

async function buildApp() {
  const { default: alertRoutes } = await import('./alerts.js');
  const app = Fastify({ logger: false });
  await app.register(alertRoutes);
  await app.ready();
  return app;
}

const metricBody = JSON.stringify({
  action: 'critical',
  data: {
    metric_alert: {
      title: 'P0 核心接口 5xx 比例',
      alert_rule: { id: 1, name: 'P0 核心接口 5xx 比例' },
    },
  },
});

const sign = (body: string) => createHmac('sha256', CLIENT_SECRET).update(body).digest('hex');

describe('POST /api/alerts/sentry', () => {
  it('rejects requests with no credentials', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/alerts/sentry',
      headers: { 'content-type': 'application/json' },
      payload: metricBody,
    });
    expect(response.statusCode).toBe(401);
    expect(mocks.publish).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a wrong signature', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/alerts/sentry',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': 'deadbeef',
      },
      payload: metricBody,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a correctly signed payload and relays it to the publisher', async () => {
    const app = await buildApp();
    mocks.publish.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: '/api/alerts/sentry',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': sign(metricBody),
      },
      payload: metricBody,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({
      domain: 'errors',
      severity: 'P0',
      environment: 'production',
    });
    await app.close();
  });

  it('accepts the shared-secret header for manual debugging', async () => {
    const app = await buildApp();
    mocks.publish.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: '/api/alerts/sentry',
      headers: { 'content-type': 'application/json', 'x-alert-secret': SECRET },
      payload: metricBody,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('accepts the shared secret via the webhook URL query token', async () => {
    const app = await buildApp();
    mocks.publish.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: `/api/alerts/sentry?token=${SECRET}`,
      headers: { 'content-type': 'application/json' },
      payload: metricBody,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects a wrong query token', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/alerts/sentry?token=wrong',
      headers: { 'content-type': 'application/json' },
      payload: metricBody,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('acknowledges non-alert payloads without publishing', async () => {
    const app = await buildApp();
    mocks.publish.mockClear();
    const body = '{"action":"assigned"}';
    const response = await app.inject({
      method: 'POST',
      url: '/api/alerts/sentry',
      headers: { 'content-type': 'application/json', 'sentry-hook-signature': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ignored: 'unsupported_action' });
    expect(mocks.publish).not.toHaveBeenCalled();
    await app.close();
  });
});
