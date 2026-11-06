import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateCreatorCharacterSchema,
  SaveCreatorCharacterSchema,
  PublishCreatorCharacterSchema,
  SetCreatorVisibilitySchema,
  creatorPublishMissingFields,
  CreatorCharacterIdSchema,
  CreatorReviewTestRequestSchema,
  type CreatorReviewTestData,
  CREATOR_REVIEW_REJECTED_CODE,
  CREATOR_REVIEW_UNAVAILABLE_CODE,
  type CreatorVisibility,
  type GetCreatorCharacterData,
  fail,
  ok,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { AdminSessionError, requireAdminActor } from '../features/admin-access/session.js';
import { CharacterWishRepository } from '../features/character-wishes/repository.js';
import { CreatorCharacterRepository } from '../features/creator/repository.js';
import { clearLobbyFeaturedSnapshot } from '../features/lobby/featured-snapshot.js';
import { testCreatorCharacterReview } from '../features/generation/creator-review.js';

const idSchema = CreatorCharacterIdSchema;

/** 审核不可用的分类标签（如 http_429、invalid_response）；只认固定词表形态，绝不透出供应商正文。 */
function reviewFailureOf(err: unknown): string {
  const failure = err && typeof err === 'object' && 'failure' in err ? err.failure : null;
  return typeof failure === 'string' && /^[a-z0-9_]{1,40}$/.test(failure) ? failure : 'unknown';
}

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
        if (code === CREATOR_REVIEW_REJECTED_CODE && err instanceof Error)
          return reply.code(422).send(fail(CREATOR_REVIEW_REJECTED_CODE, err.message));
        if (code === CREATOR_REVIEW_UNAVAILABLE_CODE) {
          request.log.warn(
            {
              err: Object.assign(new Error('Creator review unavailable'), { code }),
              event: 'creator.review.unavailable',
              failure: reviewFailureOf(err),
              action,
            },
            'creator review unavailable'
          );
          return reply
            .code(503)
            .send(
              fail(CREATOR_REVIEW_UNAVAILABLE_CODE, '暂时无法完成审核，请稍后重试。原稿已保留。')
            );
        }
        if (code === 'MISSING_FIELDS' && err instanceof Error)
          return reply.code(400).send(fail('MISSING_FIELDS', err.message));
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

  const publishCharacter = async (input: {
    ownerId: string;
    id: string;
    action: 'publish' | 'visibility';
    expectedRevision: number;
    visibility: CreatorVisibility;
  }) => {
    const current = await repo.get(input.id, input.ownerId);
    // Let SQL replay the exact last request or reject a stale revision.
    if (current.revision !== input.expectedRevision) return repo.mutate(input);
    if (input.action === 'publish' || input.visibility === 'public') {
      const missing = creatorPublishMissingFields(current.draft, current.cover_asset_id);
      if (missing.length)
        throw Object.assign(new Error('请先完成：' + missing.join('、')), {
          code: 'MISSING_FIELDS',
        });
    }
    if (input.visibility === 'private') return repo.mutate(input);
    // Public submissions currently pass directly; retain the review service for future use.
    // SQL still enforces ownership, required fields and the exact draft revision atomically.
    return repo.mutate({ ...input, review: { approved: true, reason: '直接发布' } });
  };

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
      const character = await publishCharacter({
        ownerId,
        id: characterId(request),
        action: 'publish',
        expectedRevision: body.expected_revision,
        visibility: body.visibility,
      });
      clearLobbyFeaturedSnapshot();
      const data: GetCreatorCharacterData = { character };
      if (body.wish_id && character.visibility === 'public') {
        // Publication is already durable; a withdrawn wish must not turn it into a failed publish.
        try {
          await new CharacterWishRepository().linkResponse({
            userId: ownerId,
            wishId: body.wish_id,
            characterId: character.id,
          });
          data.wish_response = { wish_id: body.wish_id, status: 'linked' };
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
          request.log.warn(
            {
              err: Object.assign(new Error('Wish association failed after publication'), { code }),
              character_id: character.id,
              wish_id: body.wish_id,
            },
            'creator wish association'
          );
          data.wish_response = { wish_id: body.wish_id, status: 'not_linked' };
        }
      }
      return reply.send(ok(data));
    })
  );
  // @frontend-ready: true — unlisting preserves card identity, existing favorites and use grants
  app.put(
    '/api/creator/characters/:id/visibility',
    ownerOptions,
    handle('visibility', async (request, reply) => {
      const body = SetCreatorVisibilitySchema.parse(request.body);
      const character = await publishCharacter({
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
  // @frontend-ready: true — Admin dry run; never saves policy or alters a real character.
  app.post(
    '/api/admin/creator-characters/review-test',
    { bodyLimit: 2 * 1024 * 1024 },
    handle('review-test', async (request, reply) => {
      await requireAdminActor(request.headers.authorization, 'write');
      const input = CreatorReviewTestRequestSchema.parse(request.body);
      const result = await testCreatorCharacterReview(input);
      request.log.info(
        { event: 'creator.review.tested', approved: result.approved },
        'creator review policy tested'
      );
      return reply.send(ok<CreatorReviewTestData>({ result }));
    })
  );
}
