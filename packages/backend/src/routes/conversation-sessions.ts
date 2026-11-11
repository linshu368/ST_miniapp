/**
 * backend / routes / conversations.ts
 *
 * 自研引擎对话链路的 REST + SSE（M3b）。方案：docs/ST_remove-MVP实施方案.md §八。
 *
 * 这条链路完全不经过 ST：会话列表直读 DB（替代 ST 的 recent 反代，总方案决策 11），
 * 生成走 M2 组 prompt + M3a 的生成出口，计费与 chat_history 与 ST 链路同一个出口、同一套口径。
 *
 * 鉴权统一用 requireTelegramAuth（X-Init-Data）；ownership 校验落在仓库层
 * （每个读写都带 user_id 过滤），所以这里不需要先查一次再判归属。
 */

import type {
  CreateConversationData,
  CreateConversationRequest,
  DeleteConversationData,
  ListConversationsData,
  UpdateConversationData,
  UpdateConversationRequest,
} from '@miniapp/shared';
import { fail, ok } from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';
import {
  applyUserPlaceholderToMessages,
  applyUserPlaceholderToSession,
  sendConversationError,
} from '../features/conversations/index.js';
import { toChatSession } from '../infrastructure/repositories/ChatSessionRepository.js';
import { requestLogger } from '../lib/logger.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

import {
  UUID_PATTERN,
  parsePositiveInt,
  type ConversationRouteRepositories,
} from './conversation-route-shared.js';

export function registerConversationCreate(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.post(
    '/api/v1/conversations',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const body = (request.body ?? {}) as Partial<CreateConversationRequest>;
      const characterId = body.character_id;
      if (typeof characterId !== 'string' || !UUID_PATTERN.test(characterId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '角色卡 ID 无效'));
      }

      const log = requestLogger(request.log, 'conversations');
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const [created, displayName] = await Promise.all([
          sessions.createSession(dbUser.id, characterId),
          settings.getDisplayName(dbUser.id),
        ]);
        log.biz.info(
          {
            event: 'conversation.session.created',
            userId: dbUser.id,
            sessionId: created.session.id,
            characterId,
          },
          '用户新建会话'
        );
        return reply.send(
          ok<CreateConversationData>({
            session: applyUserPlaceholderToSession(toChatSession(created.session), displayName),
            messages: applyUserPlaceholderToMessages(created.messages, displayName),
          })
        );
      } catch (error) {
        if (sendConversationError(reply, error)) return;
        log.sys.error(
          {
            event: 'conversation.session.create_failed',
            err: error,
            userId: dbUser.id,
            characterId,
          },
          '新建会话失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', '新建会话失败'));
      }
    }
  );
}

export function registerConversationList(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.get(
    '/api/v1/conversations',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const query = request.query as {
        character_id?: string;
        limit?: string;
        offset?: string;
      };
      if (query.character_id !== undefined && !UUID_PATTERN.test(query.character_id)) {
        return reply.status(400).send(fail('BAD_REQUEST', '角色卡 ID 无效'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      const [{ sessions: rows, total }, displayName] = await Promise.all([
        sessions.listSessions(dbUser.id, {
          characterId: query.character_id,
          limit: parsePositiveInt(query.limit),
          offset: parsePositiveInt(query.offset),
        }),
        settings.getDisplayName(dbUser.id),
      ]);

      return reply.send(
        ok<ListConversationsData>({
          sessions: rows.map((row) =>
            applyUserPlaceholderToSession(toChatSession(row), displayName)
          ),
          total,
        })
      );
    }
  );
}

export function registerConversationUpdate(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.patch(
    '/api/v1/conversations/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const sessionId = (request.params as { id?: string }).id;
      if (!sessionId || !UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      const body = (request.body ?? {}) as Partial<UpdateConversationRequest>;
      const hasTitle = 'title' in body;
      // null 是有意义的取值（恢复为角色名），所以只挡非字符串的非 null
      if (hasTitle && body.title !== null && typeof body.title !== 'string') {
        return reply.status(400).send(fail('BAD_REQUEST', '会话标题无效'));
      }
      if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
        return reply.status(400).send(fail('BAD_REQUEST', '置顶状态无效'));
      }
      if (!hasTitle && body.pinned === undefined) {
        return reply.status(400).send(fail('BAD_REQUEST', '没有需要更新的字段'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const [session, displayName] = await Promise.all([
          sessions.updateSession(sessionId, dbUser.id, {
            ...(hasTitle ? { title: body.title ?? null } : {}),
            ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
          }),
          settings.getDisplayName(dbUser.id),
        ]);
        return reply.send(
          ok<UpdateConversationData>({
            session: applyUserPlaceholderToSession(toChatSession(session), displayName),
          })
        );
      } catch (error) {
        if (sendConversationError(reply, error)) return;
        throw error;
      }
    }
  );
}

export function registerConversationDelete(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.delete(
    '/api/v1/conversations/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const sessionId = (request.params as { id?: string }).id;
      if (!sessionId || !UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        await sessions.softDelete(sessionId, dbUser.id);
        return reply.send(ok<DeleteConversationData>({ id: sessionId }));
      } catch (error) {
        if (sendConversationError(reply, error)) return;
        throw error;
      }
    }
  );

  // ── 生成（SSE）────────────────────────────────────────────────────────────
}
