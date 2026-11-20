/**
 * backend / routes / status-bar.ts
 *
 * GET    /api/conversations/:sessionId/status          — 状态面板：当前状态、生效状态栏、是否在自动更新、能否手动更新
 * POST   /api/conversations/:sessionId/status/refresh  — 手动更新（仅限 VIP，限频；不消耗星尘）
 * POST   /api/conversations/:sessionId/status/undo     — 撤销最近一次更新
 * GET    /api/characters/:characterId/status-bar       — 玩家在工具箱里看到的这张卡的状态栏（改过的 / 作者的）
 * PUT    /api/characters/:characterId/status-bar       — 保存玩家改过的状态栏（同一套语义校验）
 * DELETE /api/characters/:characterId/status-bar       — 恢复作者的版本
 * POST   /api/characters/:characterId/status-bar/ai    — 让 AI 帮忙（按方向生成 / 按方向改 / 帮写一项说明）；只回结果不保存
 *
 * 每 5 轮的自动更新不走这里，由对话链路在回复结束后触发（features/status-bar/update.ts）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  fail,
  ok,
  PlayerStatusBarAiRequestSchema,
  PutCharacterStatusBarRequestSchema,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import {
  readCharacterStatusBar,
  readConversationStatus,
  refreshConversationStatus,
  resetCharacterStatusBar,
  saveCharacterStatusBar,
  undoConversationStatus,
} from '../features/status-bar/service.js';
import { StatusBarError } from '../features/status-bar/template.js';
import { runPlayerStatusBarAi } from '../features/status-bar/player-ai.js';
import { CreatorStatusBarError } from '../features/generation/creator-status-bar.js';
import { acquireStatusBarAi } from '../features/generation/status-bar-ai-gate.js';
import { StatusBarSessionNotFoundError } from '../infrastructure/repositories/StatusBarRepository.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH = { preHandler: [requireTelegramAuth] };

const STATUS_HTTP: Record<StatusBarError['code'], number> = {
  STATUS_NOT_FOUND: 404,
  STATUS_DISABLED: 409,
  STATUS_VIP_REQUIRED: 403,
  STATUS_RATE_LIMITED: 429,
  STATUS_UPDATE_FAILED: 502,
  STATUS_INVALID_TEMPLATE: 400,
};

const dbCode = (err: unknown): string | undefined => {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === 'string' ? cause.code : undefined;
};

/** 业务错误映射成对应状态码；卡不存在或不可用（P0404 / 外键）→ 404；其余记 error 并返回 500。 */
function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  failure: { event: string; message: string }
) {
  if (err instanceof StatusBarError)
    return reply.status(STATUS_HTTP[err.code]).send(fail(err.code, err.message));
  if (err instanceof StatusBarSessionNotFoundError)
    return reply.status(404).send(fail('STATUS_NOT_FOUND', '对话不存在'));
  const code = dbCode(err);
  if (code === 'P0404' || code === '23503')
    return reply.status(404).send(fail('CHARACTER_NOT_FOUND', '角色不存在'));
  requestLogger(request.log, 'status-bar').sys.error(
    { event: failure.event, err },
    failure.message
  );
  return reply.status(500).send(fail('INTERNAL_ERROR', failure.message));
}

const sessionParam = (request: FastifyRequest) =>
  (request.params as { sessionId: string }).sessionId;
const characterParam = (request: FastifyRequest) =>
  (request.params as { characterId: string }).characterId;

function registerConversationStatusRoutes(app: FastifyInstance) {
  const base = '/api/conversations/:sessionId/status';
  const handler =
    (
      run: (
        userId: string,
        sessionId: string,
        log: ReturnType<typeof requestLogger>
      ) => Promise<unknown>,
      failure: { event: string; message: string }
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const sessionId = sessionParam(request);
      if (!UUID_REGEX.test(sessionId))
        return reply.status(400).send(fail('INVALID_SESSION_ID', 'Invalid session id'));
      try {
        const dbUser = await getOrCreateDbUser(request.user);
        return reply.send(
          ok(await run(dbUser.id, sessionId, requestLogger(request.log, 'status-bar')))
        );
      } catch (err) {
        return sendFailure(request, reply, err, failure);
      }
    };
  // @frontend-ready: true
  app.get(
    base,
    AUTH,
    handler((userId, sessionId, log) => readConversationStatus(userId, sessionId, log), {
      event: 'status_bar.read.failed',
      message: '状态读取失败',
    })
  );
  // @frontend-ready: true — 仅限 VIP；状态模型调用最长约 60 秒
  app.post(
    `${base}/refresh`,
    AUTH,
    handler((userId, sessionId, log) => refreshConversationStatus(userId, sessionId, log), {
      event: 'status_bar.refresh.failed',
      message: '状态更新失败',
    })
  );
  // @frontend-ready: true
  app.post(
    `${base}/undo`,
    AUTH,
    handler((userId, sessionId, log) => undoConversationStatus(userId, sessionId, log), {
      event: 'status_bar.undo.failed',
      message: '撤销失败',
    })
  );
}

function registerCharacterStatusBarRoutes(app: FastifyInstance) {
  const url = '/api/characters/:characterId/status-bar';
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      return null;
    }
    const characterId = characterParam(request);
    if (!UUID_REGEX.test(characterId)) {
      await reply.status(400).send(fail('INVALID_CHARACTER_ID', 'Invalid character id'));
      return null;
    }
    return { userId: (await getOrCreateDbUser(request.user)).id, characterId };
  };

  // @frontend-ready: true
  app.get(url, AUTH, async (request, reply) => {
    try {
      const who = await guard(request, reply);
      if (!who) return reply;
      return reply.send(ok(await readCharacterStatusBar(who.userId, who.characterId)));
    } catch (err) {
      return sendFailure(request, reply, err, {
        event: 'status_bar.override.read.failed',
        message: '状态栏读取失败',
      });
    }
  });

  // @frontend-ready: true
  app.put(url, AUTH, async (request, reply) => {
    const parsed = PutCharacterStatusBarRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.status(400).send(fail('STATUS_INVALID_TEMPLATE', '状态栏格式不对'));
    try {
      const who = await guard(request, reply);
      if (!who) return reply;
      const data = await saveCharacterStatusBar(who.userId, who.characterId, parsed.data.template);
      const itemCount = parsed.data.template.sections.reduce(
        (n, section) => n + section.items.length,
        0
      );
      requestLogger(request.log, 'status-bar').biz.info(
        {
          event: 'status_bar.override.saved',
          characterId: who.characterId,
          mode: 'player',
          itemCount,
        },
        '玩家状态栏已保存'
      );
      return reply.send(ok(data));
    } catch (err) {
      return sendFailure(request, reply, err, {
        event: 'status_bar.override.write.failed',
        message: '状态栏保存失败',
      });
    }
  });

  // @frontend-ready: true
  app.delete(url, AUTH, async (request, reply) => {
    try {
      const who = await guard(request, reply);
      if (!who) return reply;
      const data = await resetCharacterStatusBar(who.userId, who.characterId);
      requestLogger(request.log, 'status-bar').biz.info(
        {
          event: 'status_bar.override.saved',
          characterId: who.characterId,
          mode: 'card',
          itemCount: 0,
        },
        '已恢复作者的状态栏'
      );
      return reply.send(ok(data));
    } catch (err) {
      return sendFailure(request, reply, err, {
        event: 'status_bar.override.write.failed',
        message: '状态栏恢复失败',
      });
    }
  });

  // @frontend-ready: true — 每次最多调 3 次模型，最长约 6 分钟
  app.post(`${url}/ai`, AUTH, async (request, reply) => {
    const parsed = PlayerStatusBarAiRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.status(400).send(fail('BAD_REQUEST', '请检查状态栏和你的要求'));
    const who = await guard(request, reply);
    if (!who) return reply;
    const release = acquireStatusBarAi(who.userId);
    if (!release) return reply.status(429).send(fail('RATE_LIMITED', '上一次还在处理中，稍等一下'));
    const log = requestLogger(request.log, 'status-bar');
    const abort = new AbortController();
    const onClose = () => abort.abort();
    request.raw.on('close', onClose);
    const started = Date.now();
    const action = parsed.data.action;
    try {
      const data = await runPlayerStatusBarAi(
        who.userId,
        who.characterId,
        parsed.data,
        abort.signal
      );
      log.biz.info(
        {
          event: 'status_bar.player_ai.finished',
          characterId: who.characterId,
          action,
          durationMs: Date.now() - started,
          outcome: 'succeeded',
        },
        '玩家状态栏 AI 完成'
      );
      return reply.send(ok(data));
    } catch (err) {
      if (err instanceof CreatorStatusBarError) {
        log.biz.warn(
          {
            event: 'status_bar.player_ai.finished',
            characterId: who.characterId,
            action,
            durationMs: Date.now() - started,
            outcome: 'failed',
            code: err.code,
            err,
          },
          '玩家状态栏 AI 失败'
        );
        return err.code === 'invalid_output'
          ? reply.status(422).send(fail('STATUS_AI_INVALID', err.message))
          : reply
              .status(503)
              .send(fail('STATUS_AI_UNAVAILABLE', 'AI 暂时不可用，请稍后再试。状态栏没有改动'));
      }
      return sendFailure(request, reply, err, {
        event: 'status_bar.player_ai.failed',
        message: '状态栏 AI 失败',
      });
    } finally {
      release();
      request.raw.off('close', onClose);
    }
  });
}

export default async function statusBarRoutes(app: FastifyInstance) {
  registerConversationStatusRoutes(app);
  registerCharacterStatusBarRoutes(app);
}
