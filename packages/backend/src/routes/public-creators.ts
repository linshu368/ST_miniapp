import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  PublicCreatorSpaceQuerySchema,
  type PublicCreatorSpaceData,
} from '@miniapp/shared';
import { prisma } from '../lib/db.js';
import {
  buildPublicCreatorPageQuery,
  publicAuthorName,
  type PublicAuthorPageRow,
} from '../features/creator/public-author.js';
import { resolvePublicCharacterAvatarUrls } from './characters.js';

// PostgreSQL accepts all 128-bit UUIDs; public aliases are not v4 UUIDs.
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function publicCreatorRoutes(app: FastifyInstance) {
  // @frontend-ready: true — the author link in card detail opens this public-only collection.
  app.get<{ Params: { id: string } }>('/api/creators/:id/characters', async (request, reply) => {
    const { id } = request.params;
    const query = PublicCreatorSpaceQuerySchema.safeParse(request.query);
    reply.header('Cache-Control', 'no-store');
    if (!PUBLIC_ID.test(id) || !query.success)
      return reply.code(400).send(fail('BAD_REQUEST', '创作者或页码无效'));
    const { page } = query.data;
    try {
      const [result] = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          return tx.$queryRaw<PublicAuthorPageRow[]>(buildPublicCreatorPageQuery(id, page));
        },
        { maxWait: 2000, timeout: 6500 }
      );
      if (!result) return reply.code(404).send(fail('NOT_FOUND', '这个创作者暂无公开作品'));
      const name = publicAuthorName(result);
      const avatars = await resolvePublicCharacterAvatarUrls(result.cards, request.log);
      const characters = result.cards.map((card) => ({
        id: card.id,
        name: card.name,
        description: card.description,
        avatar_url: avatars.get(card.id) ?? '',
        personality_tags: Array.isArray(card.tags)
          ? card.tags.filter((tag): tag is string => typeof tag === 'string')
          : [],
        author_name: name,
        is_featured: false,
        like_count: card.like_count,
        favorite_count: card.favorite_count,
      }));
      return reply.send(
        ok<PublicCreatorSpaceData>({
          author_name: name,
          characters,
          page,
          has_more: result.has_more,
        })
      );
    } catch (err) {
      request.log.error({ err, page }, 'Public creator space unavailable');
      return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '作品暂时加载失败，请重试'));
    }
  });
}
