import { FastifyInstance, type FastifyBaseLogger } from 'fastify';
import { discoverableCharacterWhere, canUseCharacter } from '../features/creator/access.js';
import { resolveCreatorCoverUrl } from '../features/creator/covers.js';
import { CharacterDraftSchema } from '@miniapp/shared';
import { getDomainDb } from '../lib/supabase.js';
import { CreatorCharacterIdSchema } from '@miniapp/shared';
import { prisma } from '../lib/db.js';
import { config } from '../platform/config.js';
import { LOBBY_FEATURED_POSITION_COUNT, ok, fail, parseLobbySort } from '@miniapp/shared';
import type {
  GetCharactersData,
  GetCharacterByIdData,
  CharacterSummary,
  CharacterDetail,
  LobbyLatestBadgeData,
} from '@miniapp/shared';
import { loadCharacterRankingScores } from '../features/lobby/ranking-stats.js';
import { applyPinnedOnly, buildRecommendedOrder } from '../features/lobby/recommended-ranking.js';
import { resolveLobbyFeaturedIds } from '../features/lobby/featured.js';
import { resolveLobbyPinnedCharacters } from '../features/lobby/pinned-characters.js';
import { loadLobbyFeaturedIdSet } from '../features/lobby/featured-snapshot.js';
import { hasNewLobbyCharacters } from '../lib/lobby-latest-badge.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { optionalTelegramAuth, requireTelegramAuth } from '../middleware/auth.js';

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

/** Only call after discoverability or viewer access has been established. */
export async function resolveCharacterDisplayAvatarUrl(
  characterId: string,
  avatarUrl: string | null | undefined
): Promise<string> {
  if (avatarUrl?.startsWith('creator-cover:'))
    return (await resolveCreatorCoverUrl(avatarUrl.slice('creator-cover:'.length))) ?? '';
  return resolveCharacterAvatarUrl(characterId, avatarUrl);
}

export default async function characterRoutes(app: FastifyInstance) {
  const userSettings = new MiniappUserSettingsRepository();

  // 与首页列表用同一套可见性过滤：用户看不到的角色卡不该点亮 New。
  async function findLatestListedAt(log: FastifyBaseLogger): Promise<Date | null> {
    try {
      const listed = await prisma.character.findFirst({
        where: { ...discoverableCharacterWhere, last_listed_at: { not: null } },
        orderBy: { last_listed_at: 'desc' },
        select: { last_listed_at: true },
      });
      return listed?.last_listed_at ?? null;
    } catch (err) {
      // New 角标只是辅助提醒；角色聚合查询异常时关闭角标，不能让首页跟着不可用。
      log.warn({ err }, 'Failed to resolve latest character listing timestamp');
      return null;
    }
  }

  // @frontend-ready: true
  app.get('/api/characters', async (request, reply) => {
    const sort = parseLobbySort((request.query as { sort?: unknown } | undefined)?.sort);

    const characters = await prisma.character.findMany({
      where: discoverableCharacterWhere,
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
    let featuredIds = new Set<string>();

    if (sort === 'recommended') {
      const [snapshot, pinned] = await Promise.all([
        loadCharacterRankingScores(),
        resolveLobbyPinnedCharacters(request.log),
      ]);
      // 排序分不可用（job 还没跑过第一轮，或查询失败）时保持运营顺序。
      // 不能把空结果当成「所有卡样本都是 0」——那会让整个大厅落进冷启动池被随机打乱。
      ordered = snapshot
        ? buildRecommendedOrder({
            operatorOrdered: characters,
            scores: snapshot.scores,
            minSample: snapshot.minSample,
            protectedPrefix: LOBBY_FEATURED_POSITION_COUNT,
            pinnedIds: pinned.characterIds,
          })
        : // 分数没有也要认固定位：运营点的主推位与打分无关，不该被 job 状态连带拖掉
          applyPinnedOnly(characters, pinned.characterIds);

      featuredIds = resolveLobbyFeaturedIds({
        operatorOrdered: characters,
        snapshot,
        pinnedIds: pinned.characterIds,
      });
    }

    const charactersSummary: CharacterSummary[] = await Promise.all(
      ordered.map(async (c: (typeof characters)[number]) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        avatar_url: await resolveCharacterDisplayAvatarUrl(c.id, c.avatar_url),
        personality_tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
        author_name: c.creator,
        // 「最新」页不保留运营固定位，也不残留热门金框。
        is_featured: featuredIds.has(c.id),
      }))
    );

    // 推荐页的冷启动卡每次请求重排，缓存会把随机结果钉死；「最新」页是确定顺序，保留 60 秒。
    reply.header(
      'Cache-Control',
      sort === 'recommended'
        ? 'no-store'
        : 'public, max-age=60, s-maxage=60, stale-while-revalidate=60'
    );
    return reply.send(ok<GetCharactersData>({ characters: charactersSummary }));
  });

  // 首页「最新」入口的 New 提醒。判定全在服务端，用户换端进出算出的结果一致。
  // @frontend-ready: true
  app.get(
    '/api/characters/latest-badge',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const user = await getOrCreateDbUser(request.user);
      const [latestListedAt, lastSeenAt] = await Promise.all([
        findLatestListedAt(request.log),
        userSettings.getCharactersLastSeenAt(user.id),
      ]);

      reply.header('Cache-Control', 'no-store');
      return reply.send(
        ok<LobbyLatestBadgeData>({ has_new: hasNewLobbyCharacters(latestListedAt, lastSeenAt) })
      );
    }
  );

  // 点进「最新」即算看过本轮上新，列表为空也算；下一批角色卡上架后 New 自然恢复。
  // @frontend-ready: true
  app.post(
    '/api/characters/latest-seen',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const user = await getOrCreateDbUser(request.user);
      await userSettings.markCharactersSeen(user.id, request.user);

      reply.header('Cache-Control', 'no-store');
      return reply.send(ok<LobbyLatestBadgeData>({ has_new: false }));
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/characters/:id',
    {
      preHandler: [optionalTelegramAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const viewerId = request.user ? (await getOrCreateDbUser(request.user)).id : null;
      reply.header('Cache-Control', 'private, no-store');
      if (!(await canUseCharacter(viewerId, id)))
        return reply.status(404).send(fail('NOT_FOUND', 'Character not found'));
      const sessionId = (request.query as { session_id?: string }).session_id;
      if (sessionId !== undefined) {
        if (!viewerId) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
        if (!CreatorCharacterIdSchema.safeParse(sessionId).success)
          return reply.code(400).send(fail('BAD_REQUEST', '会话无效'));
        const { data: snapshot, error } = await getDomainDb('app_core')
          .rpc('read_session_character_version', {
            p_character_id: id,
            p_user_id: viewerId,
            p_session_id: sessionId,
            p_presentation: true,
          })
          .abortSignal(AbortSignal.timeout(5_000));
        if (error?.code === 'P0404') return reply.code(404).send(fail('NOT_FOUND', '会话不可用'));
        if (error) throw error;
        if (snapshot) {
          const frozen = snapshot as {
            name: string;
            description: string;
            avatar_url: string;
            tags: string[];
            creator: string;
            first_mes: string;
            creator_notes: string;
          };
          return reply.send(
            ok<GetCharacterByIdData>({
              character: {
                id,
                name: frozen.name,
                description: frozen.description,
                avatar_url: await resolveCharacterDisplayAvatarUrl(id, frozen.avatar_url),
                personality_tags: frozen.tags,
                author_name: frozen.creator,
                is_featured: false,
                greeting: frozen.first_mes,
                creator_notes: frozen.creator_notes,
              },
            })
          );
        }
      }

      // 金框判定必须与大厅同源，走共享快照（2s + single-flight）。原来每个请求都现拉一遍
      // 全量在架 id，与 findFirst 并行各占一条 Prisma 连接，池紧张时把等待放大一倍。
      // select 只取契约字段，不拖 raw_card 等大 JSON。
      const [character, featuredIds] = await Promise.all([
        prisma.character.findFirst({
          where: { id, enabled: true, archived_at: null },
          select: {
            id: true,
            name: true,
            description: true,
            avatar_url: true,
            tags: true,
            creator: true,
            first_mes: true,
            creator_notes: true,
          },
        }),
        loadLobbyFeaturedIdSet(request.log),
      ]);

      if (!character) {
        return reply.status(404).send(fail('NOT_FOUND', 'Character not found'));
      }

      // Draft fields are fetched only for their real author, never returned to another viewer.
      const owned = viewerId
        ? await prisma.characterCreation.findFirst({
            where: { character_id: id, owner_user_id: viewerId },
            select: { draft: true, cover_asset_id: true },
          })
        : null;
      const draft = owned ? CharacterDraftSchema.parse(owned.draft) : null;
      const characterDetail: CharacterDetail = {
        id: character.id,
        name: draft?.name ?? character.name,
        description: draft?.description ?? character.description,
        avatar_url: owned
          ? ((owned.cover_asset_id ? await resolveCreatorCoverUrl(owned.cover_asset_id) : '') ?? '')
          : await resolveCharacterDisplayAvatarUrl(character.id, character.avatar_url),
        personality_tags:
          draft?.tags ?? (Array.isArray(character.tags) ? (character.tags as string[]) : []),
        author_name: character.creator,
        is_featured: featuredIds.has(character.id),
        greeting: draft?.opening ?? character.first_mes,
        creator_notes: character.creator_notes,
      };

      return reply.send(ok<GetCharacterByIdData>({ character: characterDetail }));
    }
  );
}
