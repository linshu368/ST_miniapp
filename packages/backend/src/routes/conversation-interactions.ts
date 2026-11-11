import { fetchContextWindowLimits } from '../features/conversations/context-window.js';
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
  CancelConversationTurnData,
  CancelConversationTurnRequest,
  ForkConversationData,
  SetMessageLikeData,
} from '@miniapp/shared';
import {
  ChangeChatMessageRequestSchema,
  fail,
  ForkConversationRequestSchema,
  ok,
  ReportFirstTokenRequestSchema,
  SetMessageLikeRequestSchema,
} from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';
import {
  applyUserPlaceholderToMessages,
  applyUserPlaceholderToSession,
  sendConversationError,
} from '../features/conversations/index.js';
import { toChatSession } from '../infrastructure/repositories/ChatSessionRepository.js';
import { toChatMessages } from '../infrastructure/repositories/ConversationHistoryRepository.js';
import { GenerationObservationRepository } from '../infrastructure/repositories/GenerationObservationRepository.js';
import { requestLogger } from '../lib/logger.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

import { UUID_PATTERN, type ConversationRouteRepositories } from './conversation-route-shared.js';

export function registerConversationCancel(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:id/cancel',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const sessionId = (request.params as { id?: string }).id;
      const body = (request.body ?? {}) as Partial<CancelConversationTurnRequest>;
      if (
        !sessionId ||
        !UUID_PATTERN.test(sessionId) ||
        typeof body.assistant_message_id !== 'string' ||
        !UUID_PATTERN.test(body.assistant_message_id) ||
        (body.reason !== undefined &&
          body.reason !== 'user_stop' &&
          body.reason !== 'first_token_timeout')
      ) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话或回复 ID 无效'));
      }
      const log = requestLogger(request.log, 'conversations');
      const dbUser = await getOrCreateDbUser(request.user);
      const startedAt = Date.now();
      try {
        await sessions.requireSession(sessionId, dbUser.id);
        const row = await history.cancelTurn(sessionId, body.assistant_message_id, body.reason);
        if (!row) return reply.status(404).send(fail('NOT_FOUND', '回复不存在'));
        if (row.status === 'streaming')
          return reply.status(409).send(fail('CANCEL_PENDING', '正在取消本次回复，请稍后重试'));
        log.biz.info(
          {
            event: 'conversation.turn.cancelled',
            userId: dbUser.id,
            sessionId,
            historyId: row.id,
            status: row.status,
            elapsedMs: Date.now() - startedAt,
          },
          '取消回复请求已收口'
        );
        return reply.send(ok<CancelConversationTurnData>({ message: toChatMessages(row)[1]! }));
      } catch (err) {
        if (sendConversationError(reply, err)) return;
        log.sys.error(
          {
            event: 'conversation.turn.cancel_failed',
            err,
            userId: dbUser.id,
            sessionId,
            elapsedMs: Date.now() - startedAt,
          },
          '取消回复失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', '取消回复失败，请稍后重试'));
      }
    }
  );
}

export function registerConversationFirstToken(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:id/first-token',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const sessionId = (request.params as { id?: string }).id;
      const parsed = ReportFirstTokenRequestSchema.safeParse(request.body);
      if (!sessionId || !UUID_PATTERN.test(sessionId) || !parsed.success)
        return reply.status(400).send(fail('BAD_REQUEST', '首 token 观测字段无效'));
      const dbUser = await getOrCreateDbUser(request.user);
      const recorded = await new GenerationObservationRepository().report(
        dbUser.id,
        sessionId,
        parsed.data
      );
      return reply.send(ok({ recorded }));
    }
  );
}

export function registerConversationLike(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.put(
    '/api/v1/conversations/:id/messages/:messageId/like',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { id: sessionId, messageId } = request.params as { id?: string; messageId?: string };
      const parsed = SetMessageLikeRequestSchema.safeParse(request.body);
      if (
        !sessionId ||
        !UUID_PATTERN.test(sessionId) ||
        !messageId ||
        !UUID_PATTERN.test(messageId) ||
        !parsed.success
      ) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话、回复或点赞状态无效'));
      }
      const log = requestLogger(request.log, 'conversations');
      const startedAt = Date.now();
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const result = await history.setMessageLike({
          userId: dbUser.id,
          sessionId,
          messageId,
          liked: parsed.data.liked,
        });
        log.biz.info(
          {
            event: 'conversation.reply.like_updated',
            userId: dbUser.id,
            sessionId,
            messageId,
            liked: result.liked,
            elapsedMs: Date.now() - startedAt,
          },
          '回复点赞已更新'
        );
        return reply.send(ok<SetMessageLikeData>(result));
      } catch (err) {
        if (sendConversationError(reply, err)) return;
        log.sys.error(
          {
            event: 'conversation.reply.like_failed',
            userId: dbUser.id,
            sessionId,
            messageId,
            elapsedMs: Date.now() - startedAt,
          },
          '回复点赞更新失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', '点赞状态暂未保存，请重试'));
      }
    }
  );

  // ── 会话 CRUD ─────────────────────────────────────────────────────────────
}

export function registerConversationBranch(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:id/branch',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const sourceSessionId = (request.params as { id?: string }).id;
      const parsed = ForkConversationRequestSchema.safeParse(request.body);
      if (!sourceSessionId || !UUID_PATTERN.test(sourceSessionId) || !parsed.success) {
        return reply.status(400).send(fail('BAD_REQUEST', '分支会话或回复 ID 无效'));
      }
      const log = requestLogger(request.log, 'conversations');
      const startedAt = Date.now();
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const limits = await fetchContextWindowLimits();
        // The RPC owns authorization and idempotency together: a retry may recover
        // an already-created branch even after its original conversation was deleted.
        const [branched, displayName] = await Promise.all([
          sessions.forkSession({
            userId: dbUser.id,
            sourceSessionId,
            messageId: parsed.data.message_id,
            requestId: parsed.data.request_id,
            retainTurns: limits.retainTurns,
          }),
          settings.getDisplayName(dbUser.id),
        ]);
        const openingMessage = await sessions.getCharacterFirstMes(
          branched.character_id,
          dbUser.id,
          branched.id
        );
        const page = await history.listMessages(branched.id, openingMessage, { userId: dbUser.id });
        log.biz.info(
          {
            event: 'conversation.session.branched',
            userId: dbUser.id,
            sourceSessionId,
            sessionId: branched.id,
            inheritedTurns: branched.branch_inherited_turns,
            elapsedMs: Date.now() - startedAt,
          },
          '已开启对话分支'
        );
        return reply.send(
          ok<ForkConversationData>({
            session: applyUserPlaceholderToSession(toChatSession(branched), displayName),
            messages: applyUserPlaceholderToMessages(page.messages, displayName),
            has_more: page.hasMore,
          })
        );
      } catch (err) {
        if (sendConversationError(reply, err)) return;
        log.sys.error(
          {
            event: 'conversation.session.branch_failed',
            // Repository errors can contain upstream details. Branch logs only
            // retain identifiers and timing, never history or a database payload.
            userId: dbUser.id,
            sourceSessionId,
            elapsedMs: Date.now() - startedAt,
          },
          '开启对话分支失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', '分支暂未打开，请重试'));
      }
    }
  );
}

export function registerConversationEditMessage(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.patch(
    '/api/v1/conversations/:id/messages/:messageId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { id: sessionId, messageId } = request.params as { id: string; messageId: string };
      const parsed = ChangeChatMessageRequestSchema.safeParse(request.body);
      if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(messageId) || !parsed.success)
        return reply.status(400).send(fail('BAD_REQUEST', '消息修改内容无效'));
      const dbUser = await getOrCreateDbUser(request.user);
      const startedAt = Date.now();
      try {
        const data = await history.changeMessage({
          userId: dbUser.id,
          sessionId,
          messageId,
          body: parsed.data,
        });
        request.log.info(
          {
            event: 'conversation.message.changed',
            sessionId,
            messageId,
            role: parsed.data.role,
            action: parsed.data.action,
            elapsedMs: Date.now() - startedAt,
          },
          '消息已修改'
        );
        return reply.send(ok(data));
      } catch (err) {
        if (sendConversationError(reply, err)) return;
        // Raw database errors may contain user text in constraint details.
        request.log.error(
          {
            event: 'conversation.message.change_failed',
            sessionId,
            messageId,
            elapsedMs: Date.now() - startedAt,
          },
          '消息修改失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', '保存失败，内容已保留，请重试'));
      }
    }
  );
}
