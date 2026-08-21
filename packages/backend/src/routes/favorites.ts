/**
 * backend / routes / favorites.ts
 *
 * GET    /api/favorites/ids        — 当前用户收藏的角色卡 id，供首页 / 详情 / 对话页共享状态
 * GET    /api/favorites           — 收藏列表（角色卡摘要，按收藏时间倒序）
 * PUT    /api/favorites/:id       — 收藏
 * DELETE /api/favorites/:id       — 取消收藏
 */

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
import { loadCharacterRankingScores } from '../features/lobby/ranking-stats.js';
import { resolveLobbyPinnedCharacters } from '../features/lobby/pinned-characters.js';
import { resolveLobbyFeaturedIds } from '../features/lobby/featured.js';
import { MiniappCharacterFavoriteRepository } from '../infrastructure/repositories/MiniappCharacterFavoriteRepository.js';

const CHARACTER_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function favoriteRoutes(app: FastifyInstance) {
  const favorites = new MiniappCharacterFavoriteRepository();

  app.get('/api/favorites/ids', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const log = requestLogger(request.log, 'favorites');
    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const rows = await favorites.list(dbUser.id);
      return reply.send(
        ok<GetCharacterFavoriteIdsData>({
          character_ids: rows.map((row) => row.character_id),
        })
      );
    } catch (err) {
      log.sys.error({ event: 'favorites.ids.failed', err }, '/api/favorites/ids failed');
      return reply.status(500).send(fail('INTERNAL_ERROR', '收藏状态读取失败'));
    }
  });

  app.get('/api/favorites', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const log = requestLogger(request.log, 'favorites');
    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const favoriteRows = await favorites.list(dbUser.id);
      if (favoriteRows.length === 0) {
        return reply.send(ok<GetCharacterFavoritesData>({ characters: [] }));
      }

      // 大厅排序决定 is_featured，收藏列表必须沿用同一套判定，
      // 否则同一张卡在两个页面的热门标记会不一致。原来这里按 sort_order 前八算，
      // 而大厅早在 v3 就换成了「运营固定位 + 排序分主池前八」，两边一直是错开的。
      const [lobbyOrder, snapshot, pinned] = await Promise.all([
        prisma.character.findMany({
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
        }),
        loadCharacterRankingScores(),
        resolveLobbyPinnedCharacters(request.log),
      ]);

      const featuredIds = resolveLobbyFeaturedIds({
        operatorOrdered: lobbyOrder,
        snapshot,
        pinnedIds: pinned.characterIds,
      });

      const byId = new Map(lobbyOrder.map((character) => [character.id, character]));

      // 保留 RPC 的收藏时间倒序；RPC 已过滤下架卡，这里的 flatMap 只兜底极窄的竞态窗口。
      const characters: CharacterSummary[] = favoriteRows.flatMap((favorite) => {
        const character = byId.get(favorite.character_id);
        if (!character) return [];
        return [
          {
            id: character.id,
            name: character.name,
            description: character.description,
            avatar_url: resolveCharacterAvatarUrl(character.id, character.avatar_url),
            personality_tags: Array.isArray(character.tags) ? (character.tags as string[]) : [],
            author_name: character.creator,
            is_featured: featuredIds.has(character.id),
          },
        ];
      });

      return reply.send(ok<GetCharacterFavoritesData>({ characters }));
    } catch (err) {
      log.sys.error({ event: 'favorites.list.failed', err }, '/api/favorites failed');
      return reply.status(500).send(fail('INTERNAL_ERROR', '收藏列表读取失败'));
    }
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
              },
            })
          );
        } catch (err) {
          requestLogger(request.log, 'favorites').sys.warn(
            { event: 'favorites.update.failed', err, characterId },
            'favorite update failed'
          );
          return reply.status(400).send(fail('FAVORITE_UPDATE_FAILED', '收藏状态更新失败'));
        }
      },
    });
  }
}
