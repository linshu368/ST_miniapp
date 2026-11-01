import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateCreatorCharacterSchema,
  SaveCreatorCharacterSchema,
  PublishCreatorCharacterSchema,
  SetCreatorVisibilitySchema,
  ReviewCreatorCharacterSchema,
  creatorPublishMissingFields,
  CreatorCharacterIdSchema,
  CreatorReviewStatusSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { config } from '../platform/config.js';
import { AdminSessionError, requireAdminActor } from '../features/admin-access/session.js';
import { CreatorCharacterRepository } from '../features/creator/repository.js';
import { clearLobbyFeaturedSnapshot } from '../features/lobby/featured-snapshot.js';

const idSchema = CreatorCharacterIdSchema;
export default async function creatorCharacterRoutes(app: FastifyInstance) {
  const repo = new CreatorCharacterRepository();
  const ownerOptions = { preHandler: [requireTelegramAuth], bodyLimit: 8 * 1024 * 1024 };
  const handle =
    (action: string, run: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const started = performance.now();
      reply.header('Cache-Control', 'private, no-store');
      try {
        return await run(request, reply);
      } catch (err) {
        if (err instanceof Error && err.name === 'ZodError')
          return reply
            .code(400)
            .send(fail('BAD_REQUEST', '填写内容有误或超过导入上限，请检查后重试'));
        if (err instanceof AdminSessionError)
          return reply
            .code(err.statusCode)
            .send(fail(err.statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', err.message));
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        if (code === 'P0404') return reply.code(404).send(fail('NOT_FOUND', '角色或封面已不可用'));
        if (code === 'P0409')
          return reply.code(409).send(fail('CONFLICT', '这份角色已更新，请重新加载后再操作'));
        if (code === 'P0429')
          return reply.code(429).send(fail('RATE_LIMITED', '创作有点频繁，请稍后再试'));
        if (code === '22023')
          return reply.code(400).send(fail('BAD_REQUEST', '请先补齐角色必填内容'));
        if (code === '42501') return reply.code(403).send(fail('FORBIDDEN', '没有操作权限'));
        // RPC validation errors may contain draft fragments in detail: log only a sanitized error.
        request.log.error(
          { err: Object.assign(new Error('Creator operation failed'), { code }), action },
          'creator operation failed'
        );
        return reply
          .code(503)
          .send(fail('SERVICE_UNAVAILABLE', '暂时没能完成，请保留原稿并稍后重试'));
      } finally {
        request.log.info(
          { action, status: reply.statusCode, duration_ms: performance.now() - started },
          'creator operation'
        );
      }
    };
  const viewer = async (request: FastifyRequest) => {
    if (!request.user) throw new AdminSessionError(401, '请重新打开小程序');
    return (await getOrCreateDbUser(request.user)).id;
  };
  const characterId = (request: FastifyRequest) =>
    idSchema.parse((request.params as { id: string }).id);

  // @frontend-ready: true — caller identity also scopes an empty local draft list
  app.get(
    '/api/creator/characters',
    ownerOptions,
    handle('list', async (request, reply) => {
      const ownerId = await viewer(request);
      return reply.send(ok({ owner_user_id: ownerId, characters: await repo.list(ownerId) }));
    })
  );
  // @frontend-ready: true — same client UUID retry returns the saved draft without overwriting
  app.post(
    '/api/creator/characters',
    ownerOptions,
    handle('create', async (request, reply) => {
      const body = CreateCreatorCharacterSchema.parse(request.body);
      const character = await repo.mutate({
        ownerId: await viewer(request),
        id: body.id,
        action: 'create',
        draft: body.draft,
        coverAssetId: body.cover_asset_id,
      });
      return reply.send(ok({ character }));
    })
  );
  // @frontend-ready: true
  app.get(
    '/api/creator/characters/:id',
    ownerOptions,
    handle('read', async (request, reply) =>
      reply.send(ok({ character: await repo.get(characterId(request), await viewer(request)) }))
    )
  );
  // @frontend-ready: true — all writes use revision CAS, including clearing the cover
  app.patch(
    '/api/creator/characters/:id',
    ownerOptions,
    handle('save', async (request, reply) => {
      const body = SaveCreatorCharacterSchema.parse(request.body);
      const character = await repo.mutate({
        ownerId: await viewer(request),
        id: characterId(request),
        action: 'save',
        expectedRevision: body.expected_revision,
        draft: body.draft,
        coverAssetId: body.cover_asset_id,
      });
      return reply.send(ok({ character }));
    })
  );
  // @frontend-ready: true
  app.post(
    '/api/creator/characters/:id/publish',
    ownerOptions,
    handle('publish', async (request, reply) => {
      const body = PublishCreatorCharacterSchema.parse(request.body);
      const ownerId = await viewer(request);
      const id = characterId(request);
      const current = await repo.get(id, ownerId);
      const missing = creatorPublishMissingFields(current.draft, current.cover_asset_id);
      if (missing.length)
        return reply.code(400).send(fail('MISSING_FIELDS', `请先完成：${missing.join('、')}`));
      const character = await repo.mutate({
        ownerId,
        id,
        action: 'publish',
        expectedRevision: body.expected_revision,
        visibility: body.visibility,
      });
      clearLobbyFeaturedSnapshot();
      return reply.send(ok({ character }));
    })
  );
  // @frontend-ready: true — unlisting preserves card identity, existing favorites and use grants
  app.put(
    '/api/creator/characters/:id/visibility',
    ownerOptions,
    handle('visibility', async (request, reply) => {
      const body = SetCreatorVisibilitySchema.parse(request.body);
      const character = await repo.mutate({
        ownerId: await viewer(request),
        id: characterId(request),
        action: 'visibility',
        expectedRevision: body.expected_revision,
        visibility: body.visibility,
      });
      clearLobbyFeaturedSnapshot();
      return reply.send(ok({ character }));
    })
  );
  // @frontend-ready: true — Admin read and write auth remain tied to the selected environment
  app.get(
    '/api/admin/creator-characters',
    handle('review-list', async (request, reply) => {
      await requireAdminActor(request.headers.authorization, 'read');
      const status = CreatorReviewStatusSchema.parse(
        (request.query as { status?: string }).status ?? 'pending'
      );
      return reply.send(ok({ characters: await repo.reviews(status) }));
    })
  );
  // @frontend-ready: true
  app.get(
    '/api/admin/creator-characters/:id',
    handle('review-read', async (request, reply) => {
      await requireAdminActor(request.headers.authorization, 'read');
      return reply.send(ok({ character: await repo.get(characterId(request)) }));
    })
  );
  // @frontend-ready: true — RPC additionally verifies operator/environment and exact submission revision
  app.post(
    '/api/admin/creator-characters/:id/review',
    handle('review', async (request, reply) => {
      const actor = await requireAdminActor(request.headers.authorization, 'write');
      const body = ReviewCreatorCharacterSchema.parse(request.body);
      const character = await repo.review({
        adminId: actor.userId,
        id: characterId(request),
        submittedRevision: body.submitted_revision,
        decision: body.decision,
        reason: body.reason,
        environment: config.database.target === 'production' ? 'production' : 'test',
      });
      clearLobbyFeaturedSnapshot();
      return reply.send(ok({ character }));
    })
  );
}
