import type { FastifyRequest } from 'fastify';
import { safeBusinessFields, type BusinessFields } from './business-context.js';

/** Route templates, never raw URLs/query/body, determine what an :id represents. */
export function httpBusinessFields(request: FastifyRequest): BusinessFields {
  const route = request.routeOptions.url ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (/^\/api\/v1\/conversations(?:\/|$)/.test(route))
    return safeBusinessFields({
      business_module: /\/(voice)(?:\/|$)/.test(route)
        ? 'voice'
        : /\/(images|image|image-description)(?:\/|$)/.test(route)
          ? 'image'
          : 'chat',
      session_id: route.startsWith('/api/v1/conversations/:id') ? params.id : params.sessionId,
      message_id: params.messageId,
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
  if (/^\/api\/image-plaza(?:\/|$)/.test(route))
    return safeBusinessFields({
      business_module: 'image',
      image_conversation_id: params.conversationId,
      work_id: params.workId,
      attempt_id: params.attemptId,
    });
  const modules = [
    [/^\/api\/(?:v1\/)?voice(?:\/|$)/, 'voice'],
    [/^\/api\/(?:v1\/)?(?:image|images)(?:\/|$)/, 'image'],
    [/^\/api\/(?:growth|v1\/drama-survey)(?:\/|$)/, 'growth'],
    [/^\/api\/community(?:\/|$)/, 'community'],
    [/^\/api\/telegram\/community-webhook$/, 'community'],
    [/^\/api\/support(?:\/|$)/, 'support'],
    [/^\/api\/payment(?:\/|$)/, 'payment'],
    [/^\/api\/wallet(?:\/|$)/, 'wallet'],
    [/^\/api\/vip(?:\/|$)/, 'vip'],
    [/^\/api\/admin\/free-zone(?:\/|$)/, 'free_zone'],
  ] as const;
  const matched = modules.find(([pattern]) => pattern.test(route));
  if (matched) return { business_module: matched[1] };
  return {};
}

/** Select only named IDs for these existing DTOs; never copy a request/response body into logs. */
export function imageBodyBusinessFields(request: FastifyRequest): BusinessFields {
  const route = request.routeOptions.url;
  const body = objectFields(request.body);
  if (route === '/api/image-plaza/share')
    return safeBusinessFields({ artifact_id: body.artifact_id });
  if (route === '/api/image-plaza/conversations' && request.method === 'POST')
    return safeBusinessFields({ work_id: body.source_work_id });
  return {};
}

export function imageResponseBusinessFields(
  request: FastifyRequest,
  payload: unknown
): BusinessFields {
  if (!request.routeOptions.url?.startsWith('/api/image-plaza/')) return {};
  const envelope = objectFields(payload);
  if (envelope.success !== true) return {};
  const data = objectFields(envelope.data);
  const attempt = objectFields(data.attempt);
  return safeBusinessFields({
    image_conversation_id: objectFields(data.conversation).id ?? attempt.conversation_id,
    attempt_id: attempt.id,
    work_id: objectFields(data.work).id,
    artifact_id: objectFields(data.artifact).id,
  });
}

function objectFields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
