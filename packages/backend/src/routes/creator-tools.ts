import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreatorCoverRequestSchema,
  CreatorPolishRequestSchema,
  CreatorPresetIdSchema,
  type CreatorPresetDetailData,
  fail,
  ok,
  type CreatorCoverData,
  type CreatorPolishEvent,
} from '@miniapp/shared';
import { resolveCreatorPresets } from '../features/creator/preset-catalog.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { createCreatorCoverAsset, getCreatorCoverAsset } from '../features/creator/covers.js';
import { streamCreatorPolish, polishErrorMessage } from '../features/generation/creator-polish.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function creatorToolsRoutes(app: FastifyInstance) {
  // @frontend-ready: true — deliberate detail view; never bundled into the public catalog.
  app.get(
    '/api/creator/presets/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const parsed = CreatorPresetIdSchema.safeParse((request.params as { id: string }).id);
      if (!parsed.success) return reply.code(404).send(fail('NOT_FOUND', '找不到这套预设'));
      const started = Date.now();
      try {
        const [preset] = await resolveCreatorPresets([parsed.data]);
        reply.header('Cache-Control', 'private, max-age=300');
        request.log.info(
          {
            event: 'creator.preset.read',
            preset_id: parsed.data,
            durationMs: Date.now() - started,
          },
          'Creator preset read'
        );
        return reply.send(
          ok<CreatorPresetDetailData>({ preset: { id: parsed.data, content: preset!.content } })
        );
      } catch (err) {
        request.log.warn(
          { err, event: 'creator.preset.failed', preset_id: parsed.data },
          'Creator preset unavailable'
        );
        return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '暂时没能读取预设，请重试'));
      }
    }
  );

  // These are resource caps per process, not financial idempotency or a cross-device draft lock.
  const active = new Set<string>();
  const recent = new Map<string, number>();
  // @frontend-ready: true
  app.post(
    '/api/creator/covers',
    { preHandler: [requireTelegramAuth], bodyLimit: 29_000_000 },
    async (request, reply) => {
      const parsed = CreatorCoverRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.status(400).send(fail('BAD_REQUEST', '请选择有效的 PNG、JPEG 或 WebP 图片'));
      try {
        if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', '请先登录'));
        const user = await getOrCreateDbUser(request.user);
        const started = Date.now();
        const asset = await createCreatorCoverAsset(parsed.data, user.id);
        request.log.info(
          {
            event: 'creator.cover.saved',
            source: parsed.data.source,
            durationMs: Date.now() - started,
          },
          'Creator cover saved'
        );
        return reply.send(ok<CreatorCoverData>({ asset }));
      } catch (err) {
        return toolError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/creator/covers/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID.test(id)) return reply.status(400).send(fail('BAD_REQUEST', '封面编号无效'));
      try {
        if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', '请先登录'));
        const user = await getOrCreateDbUser(request.user);
        return reply.send(ok<CreatorCoverData>({ asset: await getCreatorCoverAsset(id, user.id) }));
      } catch (err) {
        return toolError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/creator/polish',
    { preHandler: [requireTelegramAuth], bodyLimit: 1_000_000 },
    async (request, reply) => {
      const parsed = CreatorPolishRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .status(400)
          .send(fail('BAD_REQUEST', parsed.error.issues[0]?.message ?? '请检查角色资料'));
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', '请先登录'));
      let userId: string;
      try {
        userId = (await getOrCreateDbUser(request.user)).id;
      } catch (err) {
        return toolError(request, reply, err);
      }
      if (
        active.has(userId) ||
        active.size >= 16 ||
        Date.now() - (recent.get(userId) ?? 0) < 5000
      ) {
        return reply.status(429).send(fail('RATE_LIMITED', '请稍候，上一条润色仍在处理中'));
      }
      if (recent.size >= 5000) {
        const key = recent.keys().next().value;
        if (key) recent.delete(key);
      }
      recent.set(userId, Date.now());
      active.add(userId);
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]);
      const disconnected = () => abort.abort();
      reply.raw.on('close', disconnected);
      const started = Date.now();
      const send = (event: CreatorPolishEvent) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded)
          reply.raw.write(`${JSON.stringify(event)}\n`);
      };
      reply.hijack();
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value : String(value);
      }
      reply.raw.writeHead(200, {
        ...headers,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
      try {
        const result = await streamCreatorPolish(parsed.data, signal, send);
        request.log.info(
          {
            event: 'creator.polish.finished',
            target: parsed.data.target,
            completed: result.completed,
            characters: result.characters,
            durationMs: Date.now() - started,
          },
          'Creator polish finished'
        );
      } catch (err) {
        if (!abort.signal.aborted) {
          request.log.warn(
            {
              err,
              event: 'creator.polish.failed',
              target: parsed.data.target,
              durationMs: Date.now() - started,
            },
            'Creator polish failed'
          );
          send({ type: 'error', message: polishErrorMessage(err) });
        }
      } finally {
        active.delete(userId);
        abort.abort();
        reply.raw.off('close', disconnected);
        reply.raw.end();
      }
    }
  );
}

function toolError(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : '';
  request.log.warn({ err, event: 'creator.tool.failed' }, 'Creator tool failed');
  if (message.endsWith('not_found'))
    return reply.status(404).send(fail('NOT_FOUND', '图片不存在或无权使用'));
  if (message.includes('image_size_invalid'))
    return reply.status(400).send(fail('BAD_REQUEST', '请选择20MB以内的图片'));
  if (message.includes('image_type_invalid') || message.includes('dimensions_invalid'))
    return reply.status(400).send(fail('BAD_REQUEST', '图片格式或尺寸无效，请重新选择'));
  return reply
    .status(503)
    .send(fail('CREATOR_TOOL_UNAVAILABLE', '暂时未能完成，请重试。原稿已保留。'));
}
