import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateDramaCommentSchema, SetDramaLikeSchema, fail, ok } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { DramaInteractionRepository, decodeCommentCursor } from '../features/drama/interactions.js';

export default async function dramaInteractionRoutes(app: FastifyInstance) {
  const repo = new DramaInteractionRepository();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const context = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = request.params as { id: string; commentId?: string };
    if (!uuid.test(params.id) || (params.commentId !== undefined && !uuid.test(params.commentId))) {
      reply.code(400).send(fail('BAD_REQUEST', '短剧或评论 ID 无效'));
      return null;
    }
    if (!request.user) {
      reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
      return null;
    }
    if (!(await repo.exists(params.id))) {
      reply.code(404).send(fail('NOT_FOUND', '短剧不存在'));
      return null;
    }
    const user = await getOrCreateDbUser(request.user);
    return { ...params, userId: user.id };
  };
  const handle =
    (action: string, run: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const log = requestLogger(request.log, 'drama-interactions');
      const start = performance.now();
      try {
        return await run(request, reply);
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        if (code === 'P0429')
          return reply.code(429).send(fail('RATE_LIMITED', '先歇一会儿，一分钟后再发吧'));
        if (code === '23505' || code === 'P0410')
          return reply.code(409).send(fail('CONFLICT', '这条评论已变更，请重新发表'));
        log.sys.error({ err, action }, 'drama interaction failed');
        return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '暂时没能完成，请稍后重试'));
      } finally {
        log.biz.info(
          { action, status: reply.statusCode, duration_ms: performance.now() - start },
          'drama interaction'
        );
      }
    };
  const options = { preHandler: [requireTelegramAuth] };

  // @frontend-ready: true — current drama counts and viewer like state
  app.get(
    '/api/dramas/:id/social',
    options,
    handle('social', async (request, reply) => {
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(ok({ social: await repo.social(ctx.id, ctx.userId) }));
    })
  );
  // @frontend-ready: true — desired-state like, safe to retry
  app.put(
    '/api/dramas/:id/like',
    options,
    handle('like', async (request, reply) => {
      const body = SetDramaLikeSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(fail('BAD_REQUEST', '点赞参数无效'));
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(ok({ social: await repo.setLike(ctx.id, ctx.userId, body.data.liked) }));
    })
  );
  // @frontend-ready: true — fixed 20-row cursor page, no viewer identifiers
  app.get(
    '/api/dramas/:id/comments',
    options,
    handle('comments', async (request, reply) => {
      const query = request.query as { cursor?: unknown };
      const cursor = typeof query.cursor === 'string' ? decodeCommentCursor(query.cursor) : null;
      if (query.cursor !== undefined && !cursor)
        return reply.code(400).send(fail('BAD_REQUEST', '评论分页参数无效'));
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(ok(await repo.comments(ctx.id, ctx.userId, cursor)));
    })
  );
  // @frontend-ready: true — UUID idempotency, bounded plain text, database-enforced rate limit
  app.post(
    '/api/dramas/:id/comments',
    { ...options, bodyLimit: 4096 },
    handle('comment-create', async (request, reply) => {
      const body = CreateDramaCommentSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(fail('BAD_REQUEST', '评论请填写 1–500 个字'));
      const ctx = await context(request, reply);
      if (!ctx) return;
      return reply.send(
        ok({ comment: await repo.createComment(ctx.id, ctx.userId, body.data.id, body.data.body) })
      );
    })
  );
  // @frontend-ready: true — owner-constrained deletion; missing/other-owner IDs give the same result
  app.delete(
    '/api/dramas/:id/comments/:commentId',
    options,
    handle('comment-delete', async (request, reply) => {
      const ctx = await context(request, reply);
      if (!ctx?.commentId) return;
      await repo.deleteComment(ctx.id, ctx.userId, ctx.commentId);
      return reply.send(ok({ deleted: true }));
    })
  );
}
