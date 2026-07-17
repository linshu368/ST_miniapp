import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../platform/config.js';

const ALLOWED_PATH_PREFIXES = ['auth/v1/', 'rest/v1/', 'storage/v1/'];
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-profile',
  'apikey',
  'authorization',
  'content-profile',
  'content-type',
  'prefer',
  'range',
  'x-client-info',
  'x-supabase-api-version',
];
const FORWARDED_RESPONSE_HEADERS = [
  'content-range',
  'content-type',
  'location',
  'range-unit',
  'retry-after',
  'x-supabase-api-version',
];

export function buildSupabaseProxyTarget(
  supabaseUrl: string,
  requestedPath: string,
  requestUrl: string
): URL {
  const path = requestedPath.replace(/^\/+/, '');
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error('Unsupported Supabase proxy path');
  }

  const queryIndex = requestUrl.indexOf('?');
  const query = queryIndex >= 0 ? requestUrl.slice(queryIndex) : '';
  return new URL(`${path}${query}`, `${supabaseUrl.replace(/\/+$/, '')}/`);
}

function buildUpstreamUrl(request: FastifyRequest): URL {
  return buildSupabaseProxyTarget(
    config.supabase.url,
    (request.params as { '*': string })['*'],
    request.url
  );
}

function buildRequestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

function serializeBody(request: FastifyRequest): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === undefined) {
    return undefined;
  }
  if (typeof request.body === 'string') return request.body;
  if (Buffer.isBuffer(request.body)) return request.body as unknown as BodyInit;
  return JSON.stringify(request.body);
}

export default async function adminSupabaseProxyRoutes(app: FastifyInstance) {
  app.all('/api/admin/supabase/*', async (request, reply) => {
    if (!config.supabase.url) {
      return reply.status(503).send({ message: 'Supabase proxy is not configured' });
    }

    let upstreamUrl: URL;
    try {
      upstreamUrl = buildUpstreamUrl(request);
    } catch {
      return reply.status(404).send({ message: 'Unsupported Supabase proxy path' });
    }

    try {
      const response = await fetch(upstreamUrl, {
        method: request.method,
        headers: buildRequestHeaders(request),
        body: serializeBody(request),
        redirect: 'manual',
      });

      reply.status(response.status);
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      request.log.error({ err: error, upstreamUrl: upstreamUrl.origin }, 'Supabase proxy failed');
      return reply.status(502).send({ message: 'Supabase 暂时无法访问，请稍后重试' });
    }
  });
}
