import { FirstTokenDeadlineError } from '../features/generation/first-token-fallback.js';
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
  GetGenerationConfigData,
  InsufficientBalanceErrorResponse,
  PatchGenerationConfigData,
  PatchGenerationConfigRequest,
  PatchUserSettingsRequest,
  RegenerateRequest,
  SendMessageRequest,
} from '@miniapp/shared';
import { fail, ok, PatchGenerationConfigRequestSchema } from '@miniapp/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import {
  createReplyStreamSink,
  runConversationTurn,
  sendConversationError,
  type ConversationStreamSink,
  type ConversationTurnMode,
  type ConversationTurnOutcome,
} from '../features/conversations/index.js';
import { createConversationPreparationTiming } from '../features/conversations/preparation-timing.js';
import { fetchPublicReplyStyleOptions } from '../features/conversations/reply-style-options.js';
import { prepareConversationAdmission } from '../features/conversations/turn-preparation.js';
import {
  fetchPlatformInstructions,
  toPublicWordCountTiersFromEngine,
} from '../features/engine/platform-instructions.js';
import { ChatSessionRepository } from '../infrastructure/repositories/ChatSessionRepository.js';
import { requestLogger, type RequestLogger } from '../lib/logger.js';
import { startSseResponseMetric } from '../lib/perf-metrics.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth, type TelegramUser } from '../middleware/auth.js';

import { UUID_PATTERN, type ConversationRouteRepositories } from './conversation-route-shared.js';

/**
 * 单条用户输入的上限。移动端聊天框的正常输入远在这之下，超出的多半是误粘贴或脚本，
 * 拦在入口比让它进 prompt 再把上下文顶爆便宜。
 */
const MAX_USER_INPUT_LENGTH = 8000;

export function registerConversationSend(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
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
      if (
        body.first_token_measurement !== undefined &&
        body.first_token_measurement !== 'client_committed_v4'
      ) {
        return reply.status(400).send(fail('BAD_REQUEST', '首字观测版本无效'));
      }
      if (body.thinking_enabled !== undefined && typeof body.thinking_enabled !== 'boolean') {
        return reply.status(400).send(fail('BAD_REQUEST', '思考开关无效'));
      }
      if (!isValidConversationRequestId(body.request_id)) {
        return reply.status(400).send(fail('BAD_REQUEST', '请求 ID 无效'));
      }
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        return reply.status(400).send(fail('BAD_REQUEST', '消息内容不能为空'));
      }
      if (content.length > MAX_USER_INPUT_LENGTH) {
        return reply
          .status(400)
          .send(fail('BAD_REQUEST', `消息内容不能超过 ${MAX_USER_INPUT_LENGTH} 字`));
      }

      return await streamTurn(sessions, {
        reply,
        sessionId,
        mode: { kind: 'send', content },
        requestId: body.request_id,
        firstTokenMeasurement: body.first_token_measurement,
        thinkingEnabled: body.thinking_enabled ?? false,
        tgUser: request.user,
        baseLog: request.log,
      });
    }
  );
}

export function registerConversationRegenerate(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
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

      const body = (request.body ?? {}) as Partial<RegenerateRequest>;
      if (
        body.first_token_measurement !== undefined &&
        body.first_token_measurement !== 'client_committed_v4'
      ) {
        return reply.status(400).send(fail('BAD_REQUEST', '首字观测版本无效'));
      }
      if (body.thinking_enabled !== undefined && typeof body.thinking_enabled !== 'boolean') {
        return reply.status(400).send(fail('BAD_REQUEST', '思考开关无效'));
      }
      if (!isValidConversationRequestId(body.request_id)) {
        return reply.status(400).send(fail('BAD_REQUEST', '请求 ID 无效'));
      }
      return await streamTurn(sessions, {
        reply,
        sessionId,
        mode: { kind: 'regenerate' },
        requestId: body.request_id,
        firstTokenMeasurement: body.first_token_measurement,
        thinkingEnabled: body.thinking_enabled ?? false,
        tgUser: request.user,
        baseLog: request.log,
      });
    }
  );
}

export function registerConversationGetConfig(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.get(
    '/api/v1/generation-config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const dbUser = await getOrCreateDbUser(request.user);
      const [config, platform, reply_style_options] = await Promise.all([
        settings.getGenerationConfig(dbUser.id),
        fetchPlatformInstructions(),
        fetchPublicReplyStyleOptions(),
      ]);
      const word_count_tiers = toPublicWordCountTiersFromEngine(
        platform.instructions.wordCountTiers
      );
      return reply.send(
        ok<GetGenerationConfigData>({ config, word_count_tiers, reply_style_options })
      );
    }
  );
}

export function registerConversationPatchConfig(
  app: FastifyInstance,
  { sessions, history, settings }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.patch(
    '/api/v1/generation-config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      if ('selected_model_id' in rawBody) {
        // 切模型带着「付费模型先查余额」的闸门，从这里旁路改会绕过它
        return reply
          .status(400)
          .send(fail('BAD_REQUEST', '切换模型请使用 POST /api/v1/models/select'));
      }

      const parsed = PatchGenerationConfigRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        return reply.status(400).send(fail('BAD_REQUEST', '生成配置字段无效'));
      }
      const body: PatchGenerationConfigRequest = parsed.data;

      // 仅透传生成偏好：display_name / avatar_url 归 /api/users/settings。
      const patch: PatchUserSettingsRequest = {};
      if ('pref_word_count' in body) patch.pref_word_count = body.pref_word_count;
      if ('pref_show_options' in body) patch.pref_show_options = body.pref_show_options;
      if ('pref_show_status' in body) patch.pref_show_status = body.pref_show_status;
      if ('pref_show_memory' in body) patch.pref_show_memory = body.pref_show_memory;
      if ('pref_reply_styles' in body) patch.pref_reply_styles = body.pref_reply_styles;
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

      const [config, platform, reply_style_options] = await Promise.all([
        settings.getGenerationConfig(dbUser.id),
        fetchPlatformInstructions(),
        fetchPublicReplyStyleOptions(),
      ]);
      const word_count_tiers = toPublicWordCountTiersFromEngine(
        platform.instructions.wordCountTiers
      );
      return reply.send(
        ok<PatchGenerationConfigData>({ config, word_count_tiers, reply_style_options })
      );
    }
  );
}

/** 发消息与重生成只差一个 mode，收口逻辑（402 / 502 / 流内错误）完全一样 */
async function streamTurn(
  sessions: ChatSessionRepository,
  input: {
    reply: FastifyReply;
    sessionId: string;
    mode: ConversationTurnMode;
    tgUser: TelegramUser;
    baseLog: FastifyBaseLogger;
    requestId?: string;
    thinkingEnabled: boolean;
    firstTokenMeasurement?: 'client_committed_v4';
  }
): Promise<undefined> {
  const { reply, sessionId, mode, tgUser, baseLog } = input;
  const log = requestLogger(baseLog, 'conversations');
  const receivedAt = Date.now();
  const receivedMonotonicAt = performance.now();
  // 与 Fastify onResponse 的起点对齐，包含鉴权和参数校验，而不是从进入业务编排才起算。
  const requestStartedMonotonicAt = receivedMonotonicAt - reply.elapsedTime;
  const preparationTiming = createConversationPreparationTiming(requestStartedMonotonicAt);
  const responseMetric = startSseResponseMetric(
    reply,
    mode.kind === 'send'
      ? '/api/v1/conversations/:id/messages'
      : '/api/v1/conversations/:id/regenerate',
    requestStartedMonotonicAt
  );
  // 必须在任何可能耗时的 await 之前建好：客户端断开的监听要尽早挂上
  const sink = createReplyStreamSink(reply, {
    onFirstVisibleToken: responseMetric.firstVisibleToken,
  });
  try {
    const { catalog, session, deadlineMs } = await prepareConversationAdmission(
      getOrCreateDbUser(tgUser),
      (userId) => sessions.requireSession(sessionId, userId),
      receivedMonotonicAt
    );
    const outcome = await runConversationTurn({
      session,
      mode,
      sink,
      log,
      receivedAt,
      receivedMonotonicAt,
      preparationTiming,
      firstTokenDeadlineMs: deadlineMs,
      catalogSnapshot: catalog,
      requestId: input.requestId,
      thinkingEnabled: input.thinkingEnabled,
      firstTokenMeasurement: input.firstTokenMeasurement,
    });
    finishTurn(reply, outcome);
    return undefined;
  } catch (error) {
    failTurn(reply, sink, error, log);
    return undefined;
  } finally {
    preparationTiming.incomplete();
    responseMetric.finish(reply.statusCode);
  }
}

// ── 用户生成配置 ──────────────────────────────────────────────────────────

/** 流没开起来的终态：都要以 HTTP 状态码 + JSON 返回，前端处理成本比流内错误低一截 */
function finishTurn(reply: FastifyReply, outcome: ConversationTurnOutcome): void {
  if (outcome.kind === 'streamed') return;

  if (outcome.kind === 'vip_required') {
    void reply.status(403).send(fail('VIP_REQUIRED', '标准/旗舰模型需要有效 VIP'));
    return;
  }

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
  if (error instanceof FirstTokenDeadlineError) {
    const code =
      error.stage === 'fallback'
        ? 'fallback_first_token_timeout'
        : error.stage === 'primary'
          ? 'primary_first_token_timeout'
          : 'first_token_timeout';
    if (sink.opened) {
      sink.send({ type: 'error', code, message: error.message });
      sink.close();
    } else void reply.status(504).send(fail(code, error.message));
    return;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    if (sink.opened) {
      sink.send({ type: 'error', code: 'upstream_error', message: '请求处理超时，请重试。' });
      sink.close();
    } else void reply.status(504).send(fail('upstream_error', '请求处理超时，请重试。'));
    return;
  }
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

export function isValidConversationRequestId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && UUID_PATTERN.test(value));
}
