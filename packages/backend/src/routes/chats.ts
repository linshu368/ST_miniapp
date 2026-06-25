/**
 * backend / routes / chats.ts
 *
 * GET /api/users/chats — 历史聊天列表（跨角色聚合）。
 *
 * 阶段 4 实现：反代 ST /api/chats/recent（cookie 走 Redis 缓存）。
 * 阶段 5 迁移：切换为查 Supabase st_users.user_st_chats，平台契约不变。
 */

import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import { deriveStHandle } from '@miniapp/shared';
import type { GetUserChatsData, UserChatListItem } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { fetchWithStCookie } from '../lib/st-cookie.js';
import { prisma } from '../lib/db.js';

interface STRecentChatEntry {
  file_name: string;
  file_size: number;
  mes: number;
  last_mes: string;
  chat_items?: number;
  group_id?: string;
  character_name?: string;
  character_avatar?: string;
}

const PLATFORM_AVATAR_REGEX = /^platform_([0-9a-f-]{36})\.png$/i;

export default async function chatsRoutes(app: FastifyInstance) {
  app.get('/api/users/chats', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const stHandle = deriveStHandle(request.user.id.toString());

      const result = await fetchWithStCookie<
        STRecentChatEntry[] | Record<string, STRecentChatEntry>
      >(dbUser.id, stHandle, '/api/chats/recent', {
        method: 'POST',
        body: JSON.stringify({ max: 200 }),
      });

      if (!result.ok || !result.data) {
        request.log.warn(
          { userId: dbUser.id, status: result.status },
          '[chats] ST /api/chats/recent failed'
        );
        return reply.status(502).send(fail('ST_UNAVAILABLE', 'Failed to fetch chat list'));
      }

      const rawEntries = Array.isArray(result.data) ? result.data : Object.values(result.data);

      const avatarSet = new Set<string>();
      for (const entry of rawEntries) {
        if (entry.character_avatar) avatarSet.add(entry.character_avatar);
      }

      const avatarToCharacter = await buildAvatarMap(Array.from(avatarSet));

      const items: UserChatListItem[] = rawEntries.map((entry) => {
        const avatar = entry.character_avatar ?? '';
        const mapped = avatarToCharacter.get(avatar);

        return {
          fileName: entry.file_name?.replace(/\.jsonl$/, '') ?? '',
          characterAvatar: avatar,
          characterName: mapped?.name ?? entry.character_name ?? '',
          characterId: mapped?.id ?? null,
          isGroup: Boolean(entry.group_id),
          lastMessage: entry.last_mes ?? '',
          lastMessageAt: extractTimestamp(entry.file_name) ?? '',
          messageCount: entry.mes ?? 0,
          fileSize: entry.file_size ?? 0,
        };
      });

      return reply.send(
        ok<GetUserChatsData>({
          items,
          total: items.length,
        })
      );
    } catch (err) {
      request.log.error({ err: String(err) }, '[chats] /api/users/chats failed');
      return reply.status(500).send(fail('INTERNAL_ERROR', 'Failed to fetch chat list'));
    }
  });
}

async function buildAvatarMap(
  avatars: string[]
): Promise<Map<string, { id: string; name: string }>> {
  const result = new Map<string, { id: string; name: string }>();
  if (avatars.length === 0) return result;

  const platformIds: string[] = [];
  const avatarToId = new Map<string, string>();

  for (const avatar of avatars) {
    const match = PLATFORM_AVATAR_REGEX.exec(avatar);
    if (match?.[1]) {
      platformIds.push(match[1]);
      avatarToId.set(avatar, match[1]);
    }
  }

  if (platformIds.length === 0) return result;

  const characters = await prisma.character.findMany({
    where: { id: { in: platformIds } },
    select: { id: true, name: true },
  });

  const idToName = new Map(characters.map((c) => [c.id, c.name]));

  for (const [avatar, charId] of avatarToId) {
    const name = idToName.get(charId);
    if (name) {
      result.set(avatar, { id: charId, name });
    }
  }

  return result;
}

function extractTimestamp(fileName: string | undefined): string {
  if (!fileName) return '';
  const match = /(\d{4}-\d{1,2}-\d{1,2})[@_](\d{1,2})h(\d{1,2})m(\d{1,2})s/.exec(fileName);
  if (!match) return '';
  const [, date, h, m, s] = match;
  try {
    return new Date(
      `${date}T${h?.padStart(2, '0')}:${m?.padStart(2, '0')}:${s?.padStart(2, '0')}`
    ).toISOString();
  } catch {
    return '';
  }
}
