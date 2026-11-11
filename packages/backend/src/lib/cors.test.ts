import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { normalizeConfiguredOrigin, registerCors } from './cors.js';

describe('CORS boundary', () => {
  it.each([false, true])(
    'keeps approved origins and no-origin clients in development=%s',
    async (development) => {
      const app = Fastify();
      const handler = vi.fn(() => ({ ok: true }));
      await registerCors(app, {
        frontendUrl: ' https://app.example/ ',
        adminPlatformUrl: 'https://admin.example',
        frontendAllowedOrigins: ['https://st-miniapp-frontend.vercel.app'],
        development,
      });
      app.route({ method: ['GET', 'POST'], url: '/protected', handler });
      app.get('/auth', async (_req, reply) => reply.code(401).send({ error: 'Unauthorized' }));
      app.get('/error', async () => {
        throw new Error('real failure');
      });
      try {
        for (const origin of [
          'https://app.example',
          'https://admin.example',
          'https://st-miniapp-frontend.vercel.app',
        ]) {
          const preflight = await app.inject({
            method: 'OPTIONS',
            url: '/protected',
            headers: {
              origin,
              'access-control-request-method': 'POST',
              'access-control-request-headers': 'X-Init-Data,Content-Type',
            },
          });
          expect(preflight.statusCode).toBe(204);
          expect(preflight.headers['access-control-allow-origin']).toBe(origin);
          expect(preflight.headers['timing-allow-origin']).toBe(origin);
          expect((await app.inject({ url: '/auth', headers: { origin } })).statusCode).toBe(401);
          expect((await app.inject({ url: '/error', headers: { origin } })).statusCode).toBe(500);
        }
        expect(handler).not.toHaveBeenCalled();
        for (const origin of [
          'null',
          'https://evil.example',
          'https://app.example/',
          'https://app.example.evil.test',
        ]) {
          for (const method of ['OPTIONS', 'POST'] as const) {
            expect(
              (
                await app.inject({
                  method,
                  url: '/protected',
                  headers: { origin, 'access-control-request-method': 'POST' },
                })
              ).statusCode
            ).toBe(403);
          }
        }
        expect(handler).not.toHaveBeenCalled();
        expect((await app.inject({ url: '/protected' })).statusCode).toBe(200);
        expect(
          (
            await app.inject({
              url: '/protected',
              headers: { origin: 'https://preview.vercel.app' },
            })
          ).statusCode
        ).toBe(development ? 200 : 403);
        expect(
          (await app.inject({ url: '/protected', headers: { origin: 'http://localhost:3120' } }))
            .statusCode
        ).toBe(development ? 200 : 403);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    '*',
    'https://*.vercel.app',
    'https://u:secret@app.example',
    'https://app.example/path',
    'https://app.example?token=secret',
  ])('rejects invalid deployment origin %s', (origin) => {
    expect(() => normalizeConfiguredOrigin(origin)).toThrow('exact HTTP(S) origin');
  });
});
