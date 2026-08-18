/**
 * backend / routes / chats.ts
 *
 * GET /api/users/chats — 历史聊天列表（跨角色聚合）。
 *
 * 阶段 4 实现：反代 ST /api/chats/recent（cookie 走 Redis 缓存）。
 * 阶段 5 迁移：切换为查 Supabase st_users.user_st_chats，平台契约不变。
 */

import { FastifyInstance } from 'fastify';
import * as Sentry from '@sentry/node';
import { ok, fail } from '@miniapp/shared';
import { deriveStHandle } from '@miniapp/shared';
import type { GetLatestUserChatData, GetUserChatsData, UserChatListItem } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { requestLogger, type RequestLogger } from '../lib/logger.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { fetchWithStCookie } from '../lib/st-cookie.js';
import { prisma } from '../lib/db.js';
import {
  latestChatForCharacter,
  latestChatPerCharacter,
} from '../features/chats/effective-chats.js';
import {
  bindBackendUserContext,
  captureBackendException,
  getRequestTelemetryContext,
  sendBackendSentryLog,
} from '../lib/sentry.js';

interface STRecentChatEntry {
  file_name: string;
  file_size: number | string;
  /** 最后一条消息的预览文本（ST getChatInfo 的 mes 字段） */
  mes?: string;
  /** 最后消息时间戳 */
  last_mes?: string | number;
  /** 消息条数 */
  chat_items?: number;
  group_id?: string;
  character_name?: string;
  /** ST /api/chats/recent 角色头像字段名是 avatar（来自 getChatInfo 的 additionalData） */
  avatar?: string;
  /** 兼容旧字段名 */
  character_avatar?: string;
}

const PLATFORM_AVATAR_REGEX = /^platform_([0-9a-f-]{36})\.png$/i;
const CHARACTER_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function chatsRoutes(app: FastifyInstance) {
  app.get('/api/users/chats', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const log = requestLogger(request.log, 'chats');
    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const stHandle = deriveStHandle(request.user.id.toString());
      const items = await loadCompletedChats(dbUser.id, stHandle, log);
      if (!items) {
        return reply.status(502).send(fail('ST_UNAVAILABLE', 'Failed to fetch chat list'));
      }

      return reply.send(
        ok<GetUserChatsData>({
          items,
          total: items.length,
        })
      );
    } catch (err) {
      log.sys.error({ event: 'chats.list.failed', err }, '/api/users/chats failed');
      return reply.status(500).send(fail('INTERNAL_ERROR', 'Failed to fetch chat list'));
    }
  });

  app.get(
    '/api/users/chats/latest',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      }
      const { characterId } = request.query as { characterId?: string };
      if (!characterId || !CHARACTER_ID_REGEX.test(characterId)) {
        return reply.status(400).send(fail('INVALID_CHARACTER_ID', 'Invalid character id'));
      }

      const log = requestLogger(request.log, 'chats');
      const requestTelemetry = getRequestTelemetryContext(request);
      try {
        const dbUser = await Sentry.startSpan(
          { name: 'backend.user.resolve', op: 'db.query' },
          () => getOrCreateDbUser(request.user!)
        );
        bindBackendUserContext(request.user.id.toString(), dbUser.id, characterId);
        const stHandle = deriveStHandle(request.user.id.toString());
        const items = await Sentry.startSpan(
          {
            name: 'backend.chat.latest.load',
            op: 'http.client',
            attributes: { character_id: characterId },
          },
          () => loadCompletedChats(dbUser.id, stHandle, log)
        );
        if (!items) {
          sendBackendSentryLog('error', 'backend.latest_chat.failed', {
            stage: 'latest_chat',
            result: 'st_unavailable',
            requestId: requestTelemetry.requestId,
            journeyId: requestTelemetry.journeyId,
            attemptId: requestTelemetry.attemptId,
            characterId,
          });
          return reply.status(502).send(fail('ST_UNAVAILABLE', 'Failed to fetch chat list'));
        }
        return reply.send(
          ok<GetLatestUserChatData>({
            item: latestChatForCharacter(items, characterId),
          })
        );
      } catch (err) {
        log.sys.error({ event: 'chats.latest.failed', err }, 'latest chat lookup failed');
        captureBackendException(err, request, 'latest_chat', { characterId });
        sendBackendSentryLog('error', 'backend.latest_chat.failed', {
          stage: 'latest_chat',
          result: 'failed',
          requestId: requestTelemetry.requestId,
          journeyId: requestTelemetry.journeyId,
          attemptId: requestTelemetry.attemptId,
          characterId,
        });
        return reply.status(500).send(fail('INTERNAL_ERROR', 'Failed to fetch latest chat'));
      }
    }
  );
}

async function loadCompletedChats(
  dbUserId: string,
  stHandle: string,
  log: RequestLogger
): Promise<UserChatListItem[] | null> {
  const result = await fetchWithStCookie<STRecentChatEntry[] | Record<string, STRecentChatEntry>>(
    dbUserId,
    stHandle,
    '/api/chats/recent',
    {
      method: 'POST',
      body: JSON.stringify({ max: 200 }),
    }
  );

  if (!result.ok || !result.data) {
    log.sys.warn(
      { event: 'chats.st_recent.failed', userId: dbUserId, status: result.status },
      'ST /api/chats/recent failed'
    );
    return null;
  }

  const rawEntries = Array.isArray(result.data) ? result.data : Object.values(result.data);
  const avatars = rawEntries
    .map((entry) => entry.avatar ?? entry.character_avatar)
    .filter((avatar): avatar is string => Boolean(avatar));
  const avatarToCharacter = await buildAvatarMap([...new Set(avatars)]);

  const items = rawEntries.map((entry): UserChatListItem => {
    const avatar = entry.avatar ?? entry.character_avatar ?? '';
    const mapped = avatarToCharacter.get(avatar);
    return {
      fileName: entry.file_name?.replace(/\.jsonl$/, '') ?? '',
      characterAvatar: avatar,
      characterAvatarUrl: mapped?.avatarUrl ?? '',
      characterName: mapped?.name ?? entry.character_name ?? '',
      characterId: mapped?.id ?? null,
      isGroup: Boolean(entry.group_id),
      lastMessage: entry.mes ?? '',
      lastMessageAt: normalizeTimestamp(entry.last_mes) || extractTimestamp(entry.file_name),
      messageCount: entry.chat_items ?? 0,
      fileSize: typeof entry.file_size === 'number' ? entry.file_size : 0,
    };
  });

  return latestChatPerCharacter(items);
}

async function buildAvatarMap(
  avatars: string[]
): Promise<Map<string, { id: string; name: string; avatarUrl: string }>> {
  const result = new Map<string, { id: string; name: string; avatarUrl: string }>();
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
    select: { id: true, name: true, avatar_url: true },
  });

  const idToCharacter = new Map(characters.map((character) => [character.id, character]));

  for (const [avatar, charId] of avatarToId) {
    const character = idToCharacter.get(charId);
    if (character) {
      result.set(avatar, {
        id: charId,
        name: character.name,
        avatarUrl: character.avatar_url,
      });
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

function normalizeTimestamp(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '';
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}
