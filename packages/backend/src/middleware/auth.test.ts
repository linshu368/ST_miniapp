import Fastify from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ telegramBotToken: '' }));
vi.mock('../platform/config.js', () => ({ config: settings }));
import { requireTelegramAuth } from './auth.js';
import { createObserver } from '../platform/observability/core.js';
import { registerHttpObservation } from '../platform/observability/http.js';
import type { ObservationEvent } from '../platform/observability/events.js';

afterEach(() => vi.unstubAllEnvs());
describe('Telegram authentication failure contracts', () => {
  it('binds only verified Telegram identity and keeps rejected requests anonymous', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEV_AUTH_BYPASS', '0');
    settings.telegramBotToken = randomBytes(32).toString('hex');
    const records: ObservationEvent[] = [];
    const app = Fastify();
    registerHttpObservation(
      app,
      createObserver([
        (event) => {
          records.push(event);
        },
      ])
    );
    app.get('/protected', { preHandler: requireTelegramAuth }, async () => ({}));
    const params = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 123456, first_name: 'private-name' }),
    });
    const key = createHmac('sha256', 'WebAppData').update(settings.telegramBotToken).digest();
    params.set(
      'hash',
      createHmac('sha256', key)
        .update(
          [...params.entries()]
            .map(([name, value]) => `${name}=${value}`)
            .sort()
            .join('\n')
        )
        .digest('hex')
    );
    try {
      expect(
        (await app.inject({ url: '/protected', headers: { 'x-init-data': params.toString() } }))
          .statusCode
      ).toBe(200);
      expect(records.at(-1)).toMatchObject({ telegram_user_id: '123456' });
      expect(records.at(-1)).not.toHaveProperty('user_id');
      params.set('hash', 'invalid');
      expect(
        (await app.inject({ url: '/protected', headers: { 'x-init-data': params.toString() } }))
          .statusCode
      ).toBe(401);
      expect(records.at(-1)).not.toHaveProperty('telegram_user_id');
      expect(JSON.stringify(records)).not.toContain('private-name');
    } finally {
      settings.telegramBotToken = '';
      await app.close();
    }
  });
  it.each(['production', 'development'])('limits development bypass in %s', async (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    const app = Fastify();
    // @frontend-ready: false — merge regression fixture only.
    app.get('/protected', { preHandler: requireTelegramAuth }, async () => ({ success: true }));
    try {
      const response = await app.inject('/protected');
      expect(response.statusCode).toBe(nodeEnv === 'production' ? 401 : 200);
      if (nodeEnv === 'production') expect(response.json().error.code).toBe('UNAUTHORIZED');
    } finally {
      await app.close();
    }
  });

  it('distinguishes absent identity, server configuration and invalid signature without leaking input', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '0');
    vi.stubEnv('MOCK_AUTH', '0');
    const app = Fastify();
    // @frontend-ready: false — regression fixture only.
    app.get('/protected', { preHandler: requireTelegramAuth }, async () => ({ success: true }));
    try {
      const missing = await app.inject('/protected');
      expect(missing.statusCode).toBe(401);
      expect(missing.json().error.code).toBe('UNAUTHORIZED');
      const configFailure = await app.inject({
        url: '/protected',
        headers: { 'x-init-data': 'private-input' },
      });
      expect(configFailure.statusCode).toBe(500);
      expect(configFailure.json().error.code).toBe('CONFIGURATION_ERROR');
      expect(configFailure.body).not.toContain('private');
      settings.telegramBotToken = 'test-only-placeholder';
      const rejected = await app.inject({
        url: '/protected',
        headers: { 'x-init-data': 'hash=invalid' },
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json().error.code).toBe('UNAUTHORIZED');
    } finally {
      settings.telegramBotToken = '';
      await app.close();
    }
  });
});
