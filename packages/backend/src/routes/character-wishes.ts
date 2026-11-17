import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CharacterWishQuerySchema,
  CreateCharacterWishSchema,
  RespondCharacterWishSchema,
  SupportCharacterWishSchema,
  CreatorCharacterIdSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { CharacterWishRepository } from '../features/character-wishes/repository.js';

export default async function characterWishRoutes(app: FastifyInstance) {
  const repo = new CharacterWishRepository();
  const options = { preHandler: [requireTelegramAuth], bodyLimit: 8 * 1024 };
  const wishId = (request: FastifyRequest) =>
    CreatorCharacterIdSchema.parse((request.params as { id: string }).id);
  const handle =
    (action: string, run: (request: FastifyRequest, userId: string) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.user) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
      const started = performance.now();
      try {
        const userId = (await getOrCreateDbUser(request.user)).id;
        return reply.send(ok(await run(request, userId)));
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        if ((err instanceof Error && err.name === 'ZodError') || code === '22023')
          return reply.code(400).send(fail('BAD_REQUEST', '请检查填写内容后再试'));
        if (code === 'P0404')
          return reply.code(404).send(fail('NOT_FOUND', '这条心愿或角色已不可用'));
        if (code === 'P0409')
          return reply.code(409).send(fail('CONFLICT', '这条心愿已经提交，请刷新后查看'));
        if (code === '42501') return reply.code(403).send(fail('FORBIDDEN', '没有操作权限'));
        // Database errors can include submitted text. Log codes, never the body/error detail.
        request.log.error(
          { err: Object.assign(new Error('Character wish operation failed'), { code }), action },
          'character wish operation failed'
        );
        return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '暂时没能完成，请稍后再试'));
      } finally {
        request.log.info(
          { action, status: reply.statusCode, duration_ms: performance.now() - started },
          'character wish operation'
        );
      }
    };

  // @frontend-ready: true — paginated anonymous public feed or authenticated owner's wishes.
  app.get(
    '/api/character-wishes',
    options,
    handle('list', (request, userId) =>
      repo.list(userId, CharacterWishQuerySchema.parse(request.query))
    )
  );
  // @frontend-ready: true — withdrawn and missing IDs return the same unavailable response.
  app.get(
    '/api/character-wishes/:id',
    options,
    handle('detail', (request, userId) => repo.get(userId, wishId(request)))
  );
  // @frontend-ready: true — caller UUID makes submission retries idempotent.
  app.post(
    '/api/character-wishes',
    options,
    handle('create', (request, userId) =>
      repo.create(userId, CreateCharacterWishSchema.parse(request.body))
    )
  );
  // @frontend-ready: true — explicit desired state, never an ambiguous toggle.
  app.put(
    '/api/character-wishes/:id/support',
    options,
    handle('support', (request, userId) =>
      repo.setSupported(
        userId,
        wishId(request),
        SupportCharacterWishSchema.parse(request.body).supported
      )
    )
  );
  // @frontend-ready: true — only the authenticated author can withdraw; repeated requests are safe.
  app.delete(
    '/api/character-wishes/:id',
    options,
    handle('withdraw', (request, userId) => repo.withdraw(userId, wishId(request)))
  );
  // @frontend-ready: true — only an owned, currently public published card may respond.
  app.post(
    '/api/character-wishes/:id/responses',
    options,
    handle('respond', (request, userId) =>
      repo.linkResponse({
        userId,
        wishId: wishId(request),
        characterId: RespondCharacterWishSchema.parse(request.body).character_id,
      })
    )
  );
}
