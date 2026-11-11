import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
vi.mock('./config.js', () => ({
  config: {
    nodeEnv: 'production',
    frontendUrl: 'https://mijing.example',
    adminPlatformUrl: 'https://admin.example',
  },
}));
vi.mock('./runtime-config.js', () => ({
  getMujianOrigin: () => 'https://short-drama-demo-sigma.vercel.app',
}));
import { registerAppCors } from './cors.js';
it('allows exact Mujian and existing origins but not Vercel siblings even with a development bypass flag', async () => {
  vi.stubEnv('DEV_AUTH_BYPASS', '1');
  const app = Fastify();
  await registerAppCors(app);
  app.get('/test', () => ({ ok: true }));
  try {
    for (const origin of [
      'https://short-drama-demo-sigma.vercel.app',
      'https://mijing.example',
      'https://admin.example',
    ]) {
      const response = await app.inject({ url: '/test', headers: { origin } });
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
    const rejected = await app.inject({
      url: '/test',
      headers: { origin: 'https://another.vercel.app' },
    });
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
});
