import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ telegramBotToken: '' }));
vi.mock('../platform/config.js', () => ({ config: settings }));
import { requireTelegramAuth } from './auth.js';

afterEach(() => vi.unstubAllEnvs());
describe('Telegram authentication failure contracts', () => {
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
