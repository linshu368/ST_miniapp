import type { GetConversationData } from '@miniapp/shared';
import { fail, ok } from '@miniapp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recoverActiveDelivery } from '../features/conversations/active-delivery.js';
import {
  applyUserPlaceholderToMessages,
  applyUserPlaceholderToSession,
  sendConversationError,
} from '../features/conversations/index.js';
import { toChatSession } from '../infrastructure/repositories/ChatSessionRepository.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { detailDiagnostics } from './conversation-detail-diagnostics.js';
import {
  UUID_PATTERN,
  parsePositiveInt,
  type ConversationRouteRepositories,
} from './conversation-route-shared.js';

type Repositories = Pick<ConversationRouteRepositories, 'sessions' | 'history' | 'settings'>;
type DetailQuery = { limit?: string; before_turn_index?: string; read_purpose?: string };

export function registerConversationDetail(app: FastifyInstance, repositories: Repositories) {
  // @frontend-ready: true
  app.get('/api/v1/conversations/:id', { preHandler: [requireTelegramAuth] }, (request, reply) =>
    readConversationDetail(request, reply, repositories)
  );
}

async function readConversationDetail(
  request: FastifyRequest,
  reply: FastifyReply,
  repos: Repositories
) {
  if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
  const sessionId = (request.params as { id?: string }).id;
  if (!sessionId || !UUID_PATTERN.test(sessionId))
    return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
  const query = request.query as DetailQuery;
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new DOMException('conversation_detail_deadline', 'TimeoutError')),
    8_000
  );
  const diagnostic = detailDiagnostics(
    request.log,
    query.read_purpose,
    query.before_turn_index !== undefined,
    controller.signal
  );
  const closeReason = new DOMException('conversation_detail_connection_closed', 'AbortError');
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort(closeReason);
  };
  reply.raw.once('close', onClose);
  try {
    const user = await diagnostic.measure('identity', () => getOrCreateDbUser(request.user!));
    controller.signal.throwIfAborted();
    const { session, page, displayName } = await readOwnedDetail(
      repos,
      sessionId,
      user.id,
      query,
      controller.signal,
      diagnostic
    );
    controller.signal.throwIfAborted();
    const data = await diagnostic.measure(
      'map',
      async (): Promise<GetConversationData> => ({
        session: applyUserPlaceholderToSession(toChatSession(session), displayName),
        messages: applyUserPlaceholderToMessages(
          recoverActiveDelivery(page.messages, user.id, sessionId),
          displayName
        ),
        has_more: page.hasMore,
      })
    );
    diagnostic.success(data.messages.length, page.diagnostics?.attempts ?? 1);
    return reply.send(ok(data));
  } catch (error) {
    // Only the exact close reason proves caller cancellation; dependency deadlines stay failures.
    const disconnected = controller.signal.aborted && error === closeReason;
    diagnostic.failure(error, disconnected);
    if (disconnected) {
      reply.hijack();
      return;
    }
    if (sendConversationError(reply, error)) return;
    throw error;
  } finally {
    clearTimeout(deadline);
    reply.raw.removeListener('close', onClose);
  }
}

async function readOwnedDetail(
  { sessions, history, settings }: Repositories,
  sessionId: string,
  userId: string,
  query: DetailQuery,
  signal: AbortSignal,
  diagnostic: ReturnType<typeof detailDiagnostics>
) {
  const owner = diagnostic.measure('owner', () => sessions.requireSession(sessionId, userId));
  const names = diagnostic.measure('settings', () => settings.getDisplayName(userId));
  const content = owner.then(async (session) => {
    signal.throwIfAborted();
    const opening = diagnostic.measure('opening', () =>
      sessions.getCharacterFirstMes(session.character_id, userId, session.id)
    );
    const page = diagnostic
      .measure('recover', () => history.recoverStaleStreaming(sessionId))
      .then(() => {
        signal.throwIfAborted();
        return diagnostic.measure('page', () =>
          history.listMessages(sessionId, opening, {
            userId,
            signal,
            limit: parsePositiveInt(query.limit),
            beforeTurnIndex: parsePositiveInt(query.before_turn_index),
          })
        );
      });
    // Both promises are observed immediately. History can read while opening/role access resolves,
    // but no response escapes unless that access check succeeds. Recovery still precedes the page.
    const [result] = await Promise.all([page, opening]);
    return { session, page: result };
  });
  const [result, displayName] = await Promise.all([content, names]);
  return { ...result, displayName };
}
