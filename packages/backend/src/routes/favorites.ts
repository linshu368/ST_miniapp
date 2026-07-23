import { FastifyInstance } from 'fastify';
import {
  LOBBY_FEATURED_POSITION_COUNT,
  fail,
  ok,
  type CharacterSummary,
  type GetCharacterFavoriteIdsData,
  type GetCharacterFavoritesData,
  type SetCharacterFavoriteData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { prisma } from '../lib/db.js';
import { requestLogger } from '../lib/logger.js';
import { resolveCharacterAvatarUrl } from './characters.js';
import { MiniappCharacterFavoriteRepository } from '../infrastructure/repositories/MiniappCharacterFavoriteRepository.js';

const CHARACTER_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function favoriteRoutes(app: FastifyInstance) {
  const favorites = new MiniappCharacterFavoriteRepository();

  app.get('/api/favorites/ids', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const dbUser = await getOrCreateDbUser(request.user);
    const rows = await favorites.list(dbUser.id);
    return reply.send(
      ok<GetCharacterFavoriteIdsData>({
        character_ids: rows.map((row) => row.character_id),
      })
    );
  });

  app.get('/api/favorites', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const dbUser = await getOrCreateDbUser(request.user);
    const favoriteRows = await favorites.list(dbUser.id);
    const allCharacters = await prisma.character.findMany({
      where: { enabled: true, archived_at: null },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
      select: {
        id: true,
        name: true,
        description: true,
        avatar_url: true,
        tags: true,
        creator: true,
      },
    });
    const byId = new Map(
      allCharacters.map((character, index) => [character.id, { character, index }])
    );
    const characters: CharacterSummary[] = favoriteRows.flatMap((favorite) => {
      const match = byId.get(favorite.character_id);
      if (!match) return [];
      return [
        {
          id: match.character.id,
          name: match.character.name,
          description: match.character.description,
          avatar_url: resolveCharacterAvatarUrl(match.character.id, match.character.avatar_url),
          personality_tags: Array.isArray(match.character.tags)
            ? (match.character.tags as string[])
            : [],
          author_name: match.character.creator,
          is_featured: match.index < LOBBY_FEATURED_POSITION_COUNT,
        },
      ];
    });
    return reply.send(ok<GetCharacterFavoritesData>({ characters }));
  });

  for (const [method, favorited] of [
    ['PUT', true],
    ['DELETE', false],
  ] as const) {
    app.route({
      method,
      url: '/api/favorites/:characterId',
      preHandler: [requireTelegramAuth],
      handler: async (request, reply) => {
        if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
        const { characterId } = request.params as { characterId: string };
        if (!CHARACTER_ID_REGEX.test(characterId)) {
          return reply.status(400).send(fail('INVALID_CHARACTER_ID', 'Invalid character id'));
        }
        const dbUser = await getOrCreateDbUser(request.user);
        try {
          const state = await favorites.set(dbUser.id, characterId, favorited);
          return reply.send(
            ok<SetCharacterFavoriteData>({
              favorite: {
                character_id: state.character_id,
                favorited: state.favorited,
                favorite_count: Number(state.favorite_count),
              },
            })
          );
        } catch (error) {
          requestLogger(request.log, 'favorites').sys.warn(
            { event: 'favorites.update.failed', err: error, characterId },
            'favorite update failed'
          );
          return reply.status(400).send(fail('FAVORITE_UPDATE_FAILED', '收藏状态更新失败'));
        }
      },
    });
  }
}
