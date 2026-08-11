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

import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { fail, ok } from '@miniapp/shared';
import type {
  CreateConversationData,
  CreateConversationRequest,
  DeleteConversationData,
  GetConversationData,
  GetGenerationConfigData,
  InsufficientBalanceErrorResponse,
  ListConversationsData,
  PatchGenerationConfigData,
  PatchGenerationConfigRequest,
  PatchUserSettingsRequest,
  RenameConversationRequest,
  RenameConversationData,
  SendMessageRequest,
} from '@miniapp/shared';
import { requireTelegramAuth, type TelegramUser } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger, type RequestLogger } from '../lib/logger.js';
import {
  ChatSessionRepository,
  toChatSession,
} from '../infrastructure/repositories/ChatSessionRepository.js';
import {
  ChatMessageRepository,
  toChatMessage,
} from '../infrastructure/repositories/ChatMessageRepository.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import {
  createReplyStreamSink,
  runConversationTurn,
  sendConversationError,
  type ConversationStreamSink,
  type ConversationTurnMode,
  type ConversationTurnOutcome,
} from '../features/conversations/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 单条用户输入的上限。移动端聊天框的正常输入远在这之下，超出的多半是误粘贴或脚本，
 * 拦在入口比让它进 prompt 再把上下文顶爆便宜。
 */
const MAX_USER_INPUT_LENGTH = 8000;

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

export default async function conversationRoutes(app: FastifyInstance) {
  const sessions = new ChatSessionRepository();
  const messages = new ChatMessageRepository();
  const settings = new MiniappUserSettingsRepository();

  // ── 会话 CRUD ─────────────────────────────────────────────────────────────

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
        const created = await sessions.createSession(dbUser.id, characterId);
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
            session: toChatSession(created.session),
            messages: created.messages.map(toChatMessage),
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
      const { sessions: rows, total } = await sessions.listSessions(dbUser.id, {
        characterId: query.character_id,
        limit: parsePositiveInt(query.limit),
        offset: parsePositiveInt(query.offset),
      });

      return reply.send(ok<ListConversationsData>({ sessions: rows.map(toChatSession), total }));
    }
  );

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
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const session = await sessions.requireSession(sessionId, dbUser.id);
        const page = await messages.listMessages(sessionId, {
          limit: parsePositiveInt(query.limit),
          beforeTurnIndex: parsePositiveInt(query.before_turn_index),
        });

        return reply.send(
          ok<GetConversationData>({
            session: toChatSession(session),
            messages: page.messages.map(toChatMessage),
            has_more: page.hasMore,
          })
        );
      } catch (error) {
        if (sendConversationError(reply, error)) return;
        throw error;
      }
    }
  );

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

      const body = (request.body ?? {}) as Partial<RenameConversationRequest>;
      // null 是有意义的取值（清空为自动命名），所以只挡 undefined 与非字符串
      if (body.title !== null && typeof body.title !== 'string') {
        return reply.status(400).send(fail('BAD_REQUEST', '会话标题无效'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const session = await sessions.rename(sessionId, dbUser.id, body.title);
        return reply.send(ok<RenameConversationData>({ session: toChatSession(session) }));
      } catch (error) {
        if (sendConversationError(reply, error)) return;
        throw error;
      }
    }
  );

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

  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:id/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const sessionId = (request.params as { id?: string }).id;
      if (!sessionId || !UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      const body = (request.body ?? {}) as Partial<SendMessageRequest>;
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        return reply.status(400).send(fail('BAD_REQUEST', '消息内容不能为空'));
      }
      if (content.length > MAX_USER_INPUT_LENGTH) {
        return reply
          .status(400)
          .send(fail('BAD_REQUEST', `消息内容不能超过 ${MAX_USER_INPUT_LENGTH} 字`));
      }

      return await streamTurn({
        reply,
        sessionId,
        mode: { kind: 'send', content },
        tgUser: request.user,
        baseLog: request.log,
      });
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:id/regenerate',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const sessionId = (request.params as { id?: string }).id;
      if (!sessionId || !UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      return await streamTurn({
        reply,
        sessionId,
        mode: { kind: 'regenerate' },
        tgUser: request.user,
        baseLog: request.log,
      });
    }
  );

  /** 发消息与重生成只差一个 mode，收口逻辑（402 / 502 / 流内错误）完全一样 */
  async function streamTurn(input: {
    reply: FastifyReply;
    sessionId: string;
    mode: ConversationTurnMode;
    tgUser: TelegramUser;
    baseLog: FastifyBaseLogger;
  }): Promise<undefined> {
    const { reply, sessionId, mode, tgUser, baseLog } = input;
    const log = requestLogger(baseLog, 'conversations');
    // 必须在任何可能耗时的 await 之前建好：客户端断开的监听要尽早挂上
    const sink = createReplyStreamSink(reply);

    try {
      const dbUser = await getOrCreateDbUser(tgUser);
      const session = await sessions.requireSession(sessionId, dbUser.id);
      const outcome = await runConversationTurn({ session, mode, sink, log });
      finishTurn(reply, outcome);
      return undefined;
    } catch (error) {
      failTurn(reply, sink, error, log);
      return undefined;
    }
  }

  // ── 用户生成配置 ──────────────────────────────────────────────────────────

  // @frontend-ready: true
  app.get(
    '/api/v1/generation-config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const dbUser = await getOrCreateDbUser(request.user);
      const config = await settings.getGenerationConfig(dbUser.id);
      return reply.send(ok<GetGenerationConfigData>({ config }));
    }
  );

  // @frontend-ready: true
  app.patch(
    '/api/v1/generation-config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const body = (request.body ?? {}) as PatchGenerationConfigRequest & Record<string, unknown>;
      if ('selected_model_id' in body) {
        // 切模型带着「付费模型先查余额」的闸门，从这里旁路改会绕过它
        return reply
          .status(400)
          .send(fail('BAD_REQUEST', '切换模型请使用 POST /api/v1/models/select'));
      }

      // 只透传三个 pref_* 字段：display_name / avatar_url 归 /api/users/settings
      const patch: PatchUserSettingsRequest = {};
      if ('pref_word_count' in body) patch.pref_word_count = body.pref_word_count;
      if ('pref_show_options' in body) patch.pref_show_options = body.pref_show_options;
      if ('pref_custom_instructions' in body) {
        patch.pref_custom_instructions = body.pref_custom_instructions;
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        await settings.patch(dbUser.id, request.user, patch);
      } catch (error) {
        const message = error instanceof Error ? error.message : '生成配置更新失败';
        return reply.status(400).send(fail('BAD_REQUEST', message));
      }

      const config = await settings.getGenerationConfig(dbUser.id);
      return reply.send(ok<PatchGenerationConfigData>({ config }));
    }
  );
}

/** 流没开起来的两种终态：都要以 HTTP 状态码 + JSON 返回，前端处理成本比流内错误低一截 */
function finishTurn(reply: FastifyReply, outcome: ConversationTurnOutcome): void {
  if (outcome.kind === 'streamed') return;

  if (outcome.kind === 'insufficient_balance') {
    const response: InsufficientBalanceErrorResponse = {
      error: {
        message: `Insufficient credits: have ${outcome.creditsAvailable}, need ${outcome.creditsRequired}`,
        type: 'insufficient_balance',
        credits_required: outcome.creditsRequired,
        credits_available: outcome.creditsAvailable,
      },
    };
    void reply.status(402).send(response);
    return;
  }

  void reply.status(502).send(fail('upstream_error', '生成服务暂时不可用，请稍后再试'));
}

/**
 * 异常收口。响应头写出与否决定了两条完全不同的路：
 *   没写出 → 还能用 HTTP 状态码（404 / 409 / 500）
 *   已写出 → 只能补一个流内 error 事件再收流，否则客户端会一直等下去
 */
function failTurn(
  reply: FastifyReply,
  sink: ConversationStreamSink,
  error: unknown,
  log: RequestLogger
): void {
  if (sink.opened) {
    log.sys.error(
      { event: 'conversation.turn.failed_mid_stream', err: error },
      '流已开始后失败，改以流内 error 事件收口'
    );
    sink.send({ type: 'error', code: 'upstream_error', message: '生成中断，请稍后重试' });
    sink.close();
    return;
  }

  if (sendConversationError(reply, error)) return;

  log.sys.error({ event: 'conversation.turn.failed', err: error }, '一轮生成失败');
  void reply.status(500).send(fail('INTERNAL_ERROR', '生成失败，请稍后再试'));
}
