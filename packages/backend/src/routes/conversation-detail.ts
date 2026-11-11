import { recoverActiveDelivery } from '../features/conversations/active-delivery.js';
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

import type { GetConversationData } from '@miniapp/shared';
import { fail, ok } from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';
import {
  applyUserPlaceholderToMessages,
  applyUserPlaceholderToSession,
  sendConversationError,
} from '../features/conversations/index.js';
import { toChatSession } from '../infrastructure/repositories/ChatSessionRepository.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

import {
  UUID_PATTERN,
  parsePositiveInt,
  type ConversationRouteRepositories,
} from './conversation-route-shared.js';

export function registerConversationDetail(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.get(
    '/api/v1/conversations/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const sessionId = (request.params as { id?: string }).id;
      if (!sessionId || !UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      const query = request.query as { limit?: string; before_turn_index?: string };
      const startedAt = performance.now();
      const phases: Record<string, number> = {};
      let failedPhase: string | undefined;
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', onClose);
      async function measured<T>(phase: string, run: () => Promise<T>): Promise<T> {
        const start = performance.now();
        try {
          return await run();
        } catch (error) {
          failedPhase = phase;
          throw error;
        } finally {
          phases[phase] = Math.round(performance.now() - start);
        }
      }
      try {
        const dbUser = await measured('identity', () => getOrCreateDbUser(request.user!));
        const [session, displayName] = await Promise.all([
          measured('owner', () => sessions.requireSession(sessionId, dbUser.id)),
          measured('settings', () => settings.getDisplayName(dbUser.id)),
        ]);
        const sessionMs = performance.now() - startedAt;
        // recover 与开场白互不依赖；并行少一跳再 listMessages。
        const recoverStarted = performance.now();
        const [, openingMessage] = await Promise.all([
          measured('recover', () => history.recoverStaleStreaming(sessionId)),
          measured('opening', () =>
            sessions.getCharacterFirstMes(session.character_id, dbUser.id, session.id)
          ),
        ]);
        const recoverAndOpeningMs = performance.now() - recoverStarted;
        const listStarted = performance.now();
        const page = await measured('page', () =>
          history.listMessages(sessionId, openingMessage, {
            userId: dbUser.id,
            signal: controller.signal,
            limit: parsePositiveInt(query.limit),
            beforeTurnIndex: parsePositiveInt(query.before_turn_index),
          })
        );
        const listMs = performance.now() - listStarted;
        const totalMs = performance.now() - startedAt;
        if (
          totalMs >= 1_000 ||
          page.diagnostics?.fallbackCount ||
          (page.diagnostics?.attempts ?? 1) > 1
        ) {
          request.log.warn(
            {
              event: 'conversation.detail.slow',
              phases,
              ...page.diagnostics,
              sessionId,
              totalMs: Math.round(totalMs),
              sessionMs: Math.round(sessionMs),
              recoverAndOpeningMs: Math.round(recoverAndOpeningMs),
              listMs: Math.round(listMs),
              messageCount: page.messages.length,
            },
            'slow conversation detail'
          );
        }

        return reply.send(
          ok<GetConversationData>({
            session: applyUserPlaceholderToSession(toChatSession(session), displayName),
            messages: applyUserPlaceholderToMessages(
              recoverActiveDelivery(page.messages, dbUser.id, sessionId),
              displayName
            ),
            has_more: page.hasMore,
          })
        );
      } catch (error) {
        request.log.warn(
          {
            err: error,
            event: 'conversation.detail.failed',
            phase: failedPhase,
            phases,
            elapsedMs: Math.round(performance.now() - startedAt),
          },
          'Conversation detail failed'
        );
        if (sendConversationError(reply, error)) return;
        throw error;
      } finally {
        reply.raw.removeListener('close', onClose);
      }
    }
  );
}
