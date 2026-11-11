import cors from '@fastify/cors';
import { fail } from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';

export interface CorsConfig {
  frontendUrl: string;
  adminPlatformUrl: string;
  frontendAllowedOrigins: string[];
  development: boolean;
}

/** Normalize deployment configuration only; malformed inbound origins stay rejected. */
export function normalizeConfiguredOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.hostname.includes('*')
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      'CORS configuration requires an exact HTTP(S) origin without credentials, path or wildcard'
    );
  }
}

export async function registerCors(app: FastifyInstance, config: CorsConfig): Promise<void> {
  const approved = new Set(
    [config.frontendUrl, config.adminPlatformUrl, ...config.frontendAllowedOrigins]
      .filter((value) => value.trim())
      .map(normalizeConfiguredOrigin)
  );
  function allowed(origin: string): boolean {
    if (approved.has(origin)) return true;
    if (!config.development) return false;
    try {
      const url = new URL(origin);
      return (
        origin === url.origin &&
        ((url.protocol === 'https:' && url.hostname.endsWith('.vercel.app')) ||
          (url.protocol === 'http:' && url.hostname === 'localhost'))
      );
    } catch {
      return false;
    }
  }

  // A CORS header omission alone does not prevent a cross-origin POST reaching
  // business handlers. Reject before both preflight and actual route execution.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (allowed(origin)) {
      reply.header('Timing-Allow-Origin', origin);
      return;
    }
    let originKind = 'invalid';
    try {
      const url = new URL(origin);
      originKind = url.hostname.endsWith('.vercel.app') ? 'unlisted_vercel' : 'other';
    } catch {
      /* Do not log arbitrary origin input. */
    }
    request.log.info(
      {
        event: 'cors.rejected',
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        origin_kind: originKind,
        ua_kind: /headless|playwright|puppeteer/i.test(request.headers['user-agent'] ?? '')
          ? 'automation'
          : 'other',
      },
      'Cross-origin request rejected'
    );
    reply.header('Vary', 'Origin');
    return reply.status(403).send(fail('FORBIDDEN', 'Origin is not allowed'));
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === undefined || allowed(origin)),
    credentials: true,
    maxAge: 7200,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Init-Data',
      'X-Request-Id',
      'sentry-trace',
      'baggage',
      'X-CS-Admin-Token',
      'X-CS-Operator-Id',
      'X-Bot-Internal-Secret',
      'apikey',
      'accept-profile',
      'content-profile',
      'prefer',
      'range',
      'x-client-info',
      'x-supabase-api-version',
    ],
    exposedHeaders: ['content-range', 'range-unit', 'x-supabase-api-version'],
  });
}
