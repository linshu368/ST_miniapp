/**
 * backend / routes / drama-survey.ts
 *
 * 短剧原因问卷（一次性）：查是否该弹、提交领 bonus 星尘、叉掉。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DRAMA_SURVEY_KEY,
  DRAMA_SURVEY_REWARD_CREDITS,
  DismissDramaSurveyRequestSchema,
  SubmitDramaSurveyRequestSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { DramaSurveyError, DramaSurveyRepository } from '../features/drama-survey/repository.js';

type Action = 'status' | 'submit' | 'dismiss';

export default async function dramaSurveyRoutes(app: FastifyInstance) {
  const repository = new DramaSurveyRepository();

  async function handle(action: Action, request: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'private, no-store');
    if (!request.user) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
    const submitBody =
      action === 'submit' ? SubmitDramaSurveyRequestSchema.safeParse(request.body ?? {}) : null;
    const dismissBody =
      action === 'dismiss' ? DismissDramaSurveyRequestSchema.safeParse(request.body ?? {}) : null;
    if (submitBody?.success === false || dismissBody?.success === false)
      return reply.code(400).send(fail('BAD_REQUEST', '问卷内容无效'));

    const log = requestLogger(request.log, 'drama-survey');
    const started = performance.now();
    let outcome = 'error';
    try {
      const enabled = await repository.isEnabled();
      if (!enabled && action !== 'status') {
        outcome = 'disabled';
        return reply.code(409).send(fail('SURVEY_CLOSED', '问卷已结束，感谢参与'));
      }
      const user = await getOrCreateDbUser(request.user);
      if (action === 'status') {
        const eligible = enabled && !(await repository.hasClaimed(user.id));
        outcome = eligible ? 'eligible' : enabled ? 'claimed' : 'disabled';
        return reply.send(
          ok({
            survey_key: DRAMA_SURVEY_KEY,
            eligible,
            reward_credits: DRAMA_SURVEY_REWARD_CREDITS,
          })
        );
      }
      if (action === 'dismiss') {
        if (!dismissBody?.success) throw new Error('unreachable: dismiss body not parsed');
        await repository.dismiss(user.id, dismissBody.data);
        outcome = 'dismissed';
        return reply.send(ok({ dismissed: true }));
      }
      if (!submitBody?.success) throw new Error('unreachable: submit body not parsed');
      const result = await repository.submit(user.id, submitBody.data, DRAMA_SURVEY_REWARD_CREDITS);
      outcome = result.status;
      return reply.send(ok(result));
    } catch (err) {
      // 仓储错误只带 PostgREST code，不带 detail（可能含用户填写的文字）；其他错误换成不含原文的占位。
      log.sys.error(
        { err: err instanceof DramaSurveyError ? err : new Error(`Drama survey ${action} failed`) },
        'drama survey failed'
      );
      return reply
        .code(503)
        .send(fail('SERVICE_UNAVAILABLE', action === 'submit' ? '提交失败，请重试' : '请稍后再试'));
    } finally {
      log.biz.info(
        { action, outcome, status: reply.statusCode, elapsedMs: performance.now() - started },
        'drama survey'
      );
    }
  }

  // @frontend-ready: true — 本机有过有效观看、聊满 4 轮、本地未答过时才查一次。
  app.get('/api/v1/drama-survey', { preHandler: [requireTelegramAuth] }, (request, reply) =>
    handle('status', request, reply)
  );
  // @frontend-ready: true — 提交即发奖；重复提交返回 already_rewarded，不重复发。
  app.post(
    '/api/v1/drama-survey',
    { preHandler: [requireTelegramAuth], bodyLimit: 4096 },
    (request, reply) => handle('submit', request, reply)
  );
  // @frontend-ready: true — 叉掉只记录用于算回答率，失败不影响前端关闭。
  app.post(
    '/api/v1/drama-survey/dismiss',
    { preHandler: [requireTelegramAuth], bodyLimit: 1024 },
    (request, reply) => handle('dismiss', request, reply)
  );
}
