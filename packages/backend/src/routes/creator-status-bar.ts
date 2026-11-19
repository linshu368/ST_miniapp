/**
 * backend / routes / creator-status-bar.ts
 *
 * 创作者建卡时的状态栏 AI（作者工具，不扣星尘，模型同 AI 润色，不兜底）：
 * POST /api/creator/status-bar/generate  — 根据角色资料一键生成整栏
 * POST /api/creator/status-bar/describe  — 帮写某一项的说明
 * POST /api/creator/status-bar/complete  — 只补全说明不合格的项
 * POST /api/creator/status-bar/edit      — 一句话改整栏
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, z } from 'zod';
import {
  CreatorStatusBarCompleteRequestSchema,
  CreatorStatusBarDescribeRequestSchema,
  CreatorStatusBarEditRequestSchema,
  CreatorStatusBarGenerateRequestSchema,
  fail,
  ok,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import {
  CreatorStatusBarError,
  completeCreatorStatusBar,
  describeCreatorStatusBarItem,
  editCreatorStatusBar,
  generateCreatorStatusBar,
} from '../features/generation/creator-status-bar.js';

const OPTIONS = { preHandler: [requireTelegramAuth], bodyLimit: 4 * 1024 * 1024 };
/** 同一作者同时只跑一个，两次之间至少 3 秒；全站最多 16 个并发（同 AI 润色）。 */
const active = new Set<string>();
const recent = new Map<string, number>();

const countItems = (template: StatusBarTemplate) =>
  template.sections.reduce((n, section) => n + section.items.length, 0);

function register<S extends ZodTypeAny>(
  app: FastifyInstance,
  mode: 'generate' | 'describe' | 'complete' | 'edit',
  schema: S,
  run: (body: z.infer<S>, signal: AbortSignal) => Promise<{ data: unknown; itemCount: number }>
) {
  // @frontend-ready: true
  app.post(
    `/api/creator/status-bar/${mode}`,
    OPTIONS,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success)
        return reply.status(400).send(fail('BAD_REQUEST', '请检查角色资料和状态栏'));
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', '请先登录'));
      const log = requestLogger(request.log, 'creator-status-bar');
      const userId = (await getOrCreateDbUser(request.user)).id;
      if (active.has(userId) || active.size >= 16 || Date.now() - (recent.get(userId) ?? 0) < 3000)
        return reply.status(429).send(fail('RATE_LIMITED', '上一次还在处理中，稍等一下'));
      if (recent.size >= 5000) {
        const key = recent.keys().next().value;
        if (key) recent.delete(key);
      }
      recent.set(userId, Date.now());
      active.add(userId);
      const abort = new AbortController();
      const onClose = () => abort.abort();
      request.raw.on('close', onClose);
      const started = Date.now();
      try {
        const result = await run(parsed.data, abort.signal);
        log.biz.info(
          {
            event: 'creator_status_bar.ai.finished',
            mode,
            itemCount: result.itemCount,
            durationMs: Date.now() - started,
            outcome: 'succeeded',
          },
          '状态栏 AI 完成'
        );
        return reply.send(ok(result.data));
      } catch (err) {
        const known = err instanceof CreatorStatusBarError;
        log.biz.warn(
          {
            event: 'creator_status_bar.ai.finished',
            mode,
            durationMs: Date.now() - started,
            outcome: 'failed',
            code: known ? err.code : 'unexpected',
            err,
          },
          '状态栏 AI 失败'
        );
        if (known && err.code === 'invalid_output')
          return reply.status(422).send(fail('STATUS_AI_INVALID', err.message));
        return reply
          .status(503)
          .send(fail('STATUS_AI_UNAVAILABLE', 'AI 暂时不可用，请稍后再试。已有的状态栏没有改动'));
      } finally {
        active.delete(userId);
        request.raw.off('close', onClose);
      }
    }
  );
}

export default async function creatorStatusBarRoutes(app: FastifyInstance) {
  register(app, 'generate', CreatorStatusBarGenerateRequestSchema, async (body, signal) => {
    const template = await generateCreatorStatusBar(body.draft, signal);
    return { data: { template }, itemCount: countItems(template) };
  });
  register(app, 'describe', CreatorStatusBarDescribeRequestSchema, async (body, signal) => {
    const desc = await describeCreatorStatusBarItem(body.draft, body.item, signal);
    return { data: { desc }, itemCount: 1 };
  });
  register(app, 'complete', CreatorStatusBarCompleteRequestSchema, async (body, signal) => {
    const template = await completeCreatorStatusBar(body.draft, body.template, signal);
    return { data: { template }, itemCount: countItems(template) };
  });
  register(app, 'edit', CreatorStatusBarEditRequestSchema, async (body, signal) => {
    const template = await editCreatorStatusBar(
      body.draft,
      body.template,
      body.instruction,
      signal
    );
    return { data: { template }, itemCount: countItems(template) };
  });
}
