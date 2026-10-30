import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateCharacterCommentSchema,
  ReportCharacterCommentSchema,
  SetCharacterLikeSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import {
  CharacterSocialRepository,
  decodeCharacterCommentCursor,
} from '../features/character-social/repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function characterSocialRoutes(app: FastifyInstance) {
  const repo = new CharacterSocialRepository();
  const options = { preHandler: [requireTelegramAuth] };
  const handle =
    (action: string, run: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'private, no-store');
      const log = requestLogger(request.log, 'character-social');
      const start = performance.now();
      try {
        return await run(request, reply);
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        if (code === 'P0429')
          return reply
            .header('Retry-After', '60')
            .code(429)
            .send(fail('RATE_LIMITED', '操作有点频繁，稍后再试吧'));
        if (code === 'P0404') return reply.code(404).send(fail('NOT_FOUND', '角色或评论已不可用'));
        if (code === '23505' || code === 'P0410')
          return reply.code(409).send(fail('CONFLICT', '这条评论已变更，请重新发表'));
        // Database errors may contain submitted comment text in their detail; log only safe metadata.
        const safeError = Object.assign(new Error('Character interaction failed'), {
          code: typeof code === 'string' ? code : undefined,
        });
        log.sys.error({ err: safeError, action }, 'character interaction failed');
        return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '暂时没能完成，请稍后重试'));
      } finally {
        log.biz.info(
          { action, status: reply.statusCode, duration_ms: performance.now() - start },
          'character interaction'
        );
      }
    };
  const viewer = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
      return null;
    }
    return (await getOrCreateDbUser(request.user)).id;
  };
  const context = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string; commentId?: string };
    if (!UUID.test(params.id) || (params.commentId !== undefined && !UUID.test(params.commentId))) {
      reply.code(400).send(fail('BAD_REQUEST', '角色或评论 ID 无效'));
      return null;
    }
    const userId = await viewer(request, reply);
    if (!userId) return null;
    if (!(await repo.exists(params.id, userId))) {
      reply.code(404).send(fail('NOT_FOUND', '角色已不可用'));
      return null;
    }
    return { ...params, userId };
  };

  // @frontend-ready: true — one bounded batch for visible cards, no per-card HTTP fan-out
  app.get(
    '/api/characters/social',
    options,
    handle('social-batch', async (request, reply) => {
      const { ids } = request.query as { ids?: unknown };
      if (typeof ids !== 'string' || ids.length > 1479)
        return reply.code(400).send(fail('BAD_REQUEST', '角色列表无效'));
      const values = ids.split(',').map((id) => id.toLowerCase());
      if (!values.length || values.length > 40 || values.some((id) => !UUID.test(id)))
        return reply.code(400).send(fail('BAD_REQUEST', '一次最多查询40个角色'));
      const userId = await viewer(request, reply);
      if (!userId) return;
      return reply.send(ok({ socials: await repo.socials([...new Set(values)], userId) }));
    })
  );
  // @frontend-ready: true — detail/chat aggregates and viewer like state
  app.get(
    '/api/characters/:id/social',
    options,
    handle('social', async (request, reply) => {
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(ok({ social: await repo.social(ctx.id, ctx.userId) }));
    })
  );
  // @frontend-ready: true — desired state with transactional uniqueness
  app.put(
    '/api/characters/:id/like',
    options,
    handle('like', async (request, reply) => {
      const body = SetCharacterLikeSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(fail('BAD_REQUEST', '点赞参数无效'));
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(ok({ social: await repo.setLike(ctx.id, ctx.userId, body.data.liked) }));
    })
  );
  // @frontend-ready: true — 20-row keyset page with anonymous display names
  app.get(
    '/api/characters/:id/comments',
    options,
    handle('comments', async (request, reply) => {
      const { cursor } = request.query as { cursor?: unknown };
      const decoded = typeof cursor === 'string' ? decodeCharacterCommentCursor(cursor) : null;
      if (cursor !== undefined && !decoded)
        return reply.code(400).send(fail('BAD_REQUEST', '评论分页参数无效'));
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(ok(await repo.comments(ctx.id, ctx.userId, decoded)));
    })
  );
  // @frontend-ready: true — stable UUID prevents a retry from creating another comment
  app.post(
    '/api/characters/:id/comments',
    { ...options, bodyLimit: 4096 },
    handle('comment-create', async (request, reply) => {
      const body = CreateCharacterCommentSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(fail('BAD_REQUEST', '评论请填写 1–500 个字'));
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(
        ok({ comment: await repo.createComment(ctx.id, ctx.userId, body.data.id, body.data.body) })
      );
    })
  );
  // @frontend-ready: true — only the authenticated author can soft-delete
  app.delete(
    '/api/characters/:id/comments/:commentId',
    options,
    handle('comment-delete', async (request, reply) => {
      const ctx = await context(request, reply);
      if (!ctx?.commentId) return;
      await repo.deleteComment(ctx.id, ctx.userId, ctx.commentId);
      return reply.send(ok({ deleted: true }));
    })
  );
  // @frontend-ready: true — one report per viewer/comment, no public reporter identity
  app.post(
    '/api/characters/:id/comments/:commentId/report',
    { ...options, bodyLimit: 1024 },
    handle('comment-report', async (request, reply) => {
      const body = ReportCharacterCommentSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(fail('BAD_REQUEST', '举报原因无效'));
      const ctx = await context(request, reply);
      if (!ctx?.commentId) return;
      await repo.reportComment(ctx.id, ctx.userId, ctx.commentId, body.data.reason);
      return reply.send(ok({ reported: true }));
    })
  );
}
