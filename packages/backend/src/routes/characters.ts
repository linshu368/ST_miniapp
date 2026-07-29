import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { config } from '../platform/config.js';
import { LOBBY_FEATURED_POSITION_COUNT, ok, fail, parseLobbySort } from '@miniapp/shared';
import type {
  GetCharactersData,
  GetCharacterByIdData,
  CharacterSummary,
  CharacterDetail,
} from '@miniapp/shared';
import { loadCharacterEngagementStats } from '../features/lobby/engagement-stats.js';
import { buildRecommendedOrder, dailyShuffleSeed } from '../features/lobby/recommended-ranking.js';

const CHARACTER_STORAGE_BUCKET = process.env.CHARACTER_STORAGE_BUCKET || 'character-assets';

export function resolveCharacterAvatarUrl(
  characterId: string,
  avatarUrl: string | null | undefined
): string {
  const existing = avatarUrl?.trim();
  if (existing) return existing;
  if (!config.supabase.url) return '';

  const storagePath = `characters/platform_${characterId}.png`;
  return `${config.supabase.url}/storage/v1/object/public/${CHARACTER_STORAGE_BUCKET}/${storagePath}`;
}

export default async function characterRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/characters', async (request, reply) => {
    const sort = parseLobbySort((request.query as { sort?: unknown } | undefined)?.sort);

    const characters = await prisma.character.findMany({
      where: { enabled: true, archived_at: null },
      // 「最新」只看最后上架时间；「推荐」先取运营顺序，再在内存里做动态排序。
      orderBy:
        sort === 'latest'
          ? [{ last_listed_at: 'desc' }, { created_at: 'desc' }]
          : [{ sort_order: 'asc' }, { created_at: 'desc' }],
      select: {
        id: true,
        name: true,
        description: true,
        avatar_url: true,
        tags: true,
        creator: true,
      },
    });

    let ordered = characters;
    if (sort === 'recommended') {
      const engagement = await loadCharacterEngagementStats();
      // 聚合不可用时保持运营顺序，宁可不动态排序也不能把首页排乱。
      if (engagement) {
        ordered = buildRecommendedOrder({
          operatorOrdered: characters,
          engagement,
          fixedCount: LOBBY_FEATURED_POSITION_COUNT,
          seed: dailyShuffleSeed(),
        });
      }
    }

    const charactersSummary: CharacterSummary[] = ordered.map(
      (c: (typeof characters)[number], index) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        avatar_url: resolveCharacterAvatarUrl(c.id, c.avatar_url),
        personality_tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
        author_name: c.creator,
        // 「最新」页不保留运营固定位，也不残留热门金框。
        is_featured: sort === 'recommended' && index < LOBBY_FEATURED_POSITION_COUNT,
      })
    );

    reply.header('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=60');
    return reply.send(ok<GetCharactersData>({ characters: charactersSummary }));
  });

  // @frontend-ready: true
  app.get('/api/characters/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const [character, featured] = await Promise.all([
      prisma.character.findFirst({
        where: { id, enabled: true, archived_at: null },
      }),
      prisma.character.findMany({
        where: { enabled: true, archived_at: null },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
        select: { id: true },
        take: LOBBY_FEATURED_POSITION_COUNT,
      }),
    ]);

    if (!character) {
      return reply.status(404).send(fail('NOT_FOUND', 'Character not found'));
    }

    const characterDetail: CharacterDetail = {
      id: character.id,
      name: character.name,
      description: character.description,
      avatar_url: resolveCharacterAvatarUrl(character.id, character.avatar_url),
      personality_tags: Array.isArray(character.tags) ? (character.tags as string[]) : [],
      author_name: character.creator,
      is_featured: featured.some((item) => item.id === character.id),
      greeting: character.first_mes,
      creator_notes: character.creator_notes,
    };

    return reply.send(ok<GetCharacterByIdData>({ character: characterDetail }));
  });
}
