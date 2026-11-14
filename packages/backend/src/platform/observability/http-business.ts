import type { FastifyRequest } from 'fastify';
import { safeBusinessFields, type BusinessFields } from './business-context.js';

/** Route templates, never raw URLs/query/body, determine what an :id represents. */
export function httpBusinessFields(request: FastifyRequest): BusinessFields {
  const route = request.routeOptions.url ?? '';
  const params = request.params as { id?: unknown } | undefined;
  if (/^\/api\/v1\/conversations(?:\/|$)/.test(route))
    return safeBusinessFields({
      business_module: 'chat',
      session_id: route.startsWith('/api/v1/conversations/:id') ? params?.id : undefined,
    });
  if (/^\/api\/creator(?:\/|$)/.test(route))
    return safeBusinessFields({
      business_module: 'creator',
      character_id: route.startsWith('/api/creator/characters/:id') ? params?.id : undefined,
      creation_id: route.startsWith('/api/creator/characters/:id') ? params?.id : undefined,
    });
  if (/^\/api\/characters(?:\/|$)/.test(route))
    return safeBusinessFields({
      business_module: 'character',
      character_id: route.startsWith('/api/characters/:id') ? params?.id : undefined,
    });
  if (/^\/api\/dramas(?:\/|$)/.test(route))
    return safeBusinessFields({
      business_module: 'drama',
      drama_id: route.startsWith('/api/dramas/:id') ? params?.id : undefined,
    });
  return {};
}
