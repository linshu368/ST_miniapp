import { fail } from '@miniapp/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getImagePlazaRuntimeConfig } from '../features/image-plaza/config.js';
import { getVideoStreamConfig } from '../platform/runtime-config.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { config } from '../platform/config.js';

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function userContext(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    return null;
  }
  return getOrCreateDbUser(request.user);
}

export async function requireEnabled() {
  const runtime = await getImagePlazaRuntimeConfig();
  if (!runtime.enabled) throw new Error('image_plaza_disabled');
  return runtime;
}

export function requireGenerationProvider(): void {
  // 没有 worker 或 provider key 时任务必然失败，必须在写消息/attempt 前同步拒绝。
  if (!config.imagePlaza.workerEnabled || !config.imagePlaza.apiKey) {
    throw new Error('image_plaza_provider_unavailable');
  }
}

export function requireVideoGenerationProvider(): void {
  if (
    !config.imagePlaza.videoWorkerEnabled ||
    !config.imagePlaza.apiKey ||
    !getVideoStreamConfig()
  ) {
    throw new Error('video_plaza_provider_unavailable');
  }
}
