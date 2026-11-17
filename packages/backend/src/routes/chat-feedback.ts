import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SaveChatFeedbackRequestSchema, fail, ok } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { ChatFeedbackError, ChatFeedbackRepository } from '../features/chat-feedback/repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default async function chatFeedbackRoutes(app: FastifyInstance) {
  const repository = new ChatFeedbackRepository();
  async function handle(request: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'private, no-store');
    if (!request.user) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
    const { id, messageId } = request.params as { id: string; messageId: string };
    const write = request.method === 'PUT';
    const parsed = SaveChatFeedbackRequestSchema.safeParse(request.body);
    const versionInput = (request.query as { edit_version?: string }).edit_version;
    const version = versionInput && /^\d+$/.test(versionInput) ? Number(versionInput) : NaN;
    if (
      !UUID.test(id) ||
      !UUID.test(messageId) ||
      (write
        ? !parsed.success
        : !Number.isSafeInteger(version) || version < 0 || version > 2147483647)
    )
      return reply.code(400).send(fail('BAD_REQUEST', '反馈内容或回复信息无效'));
    const log = requestLogger(request.log, 'chat-feedback');
    const started = performance.now();
    try {
      const user = await getOrCreateDbUser(request.user);
      const result =
        write && parsed.success
          ? await repository.save(user.id, id, messageId, parsed.data)
          : await repository.get(user.id, id, messageId, version);
      return reply.send(ok(result));
    } catch (err) {
      if (err instanceof ChatFeedbackError) {
        if (err.code === 'P0002') return reply.code(404).send(fail('NOT_FOUND', '对话已不存在'));
        if (err.code === 'P0426')
          return reply
            .code(409)
            .send(fail('REPLY_CHANGED', '这条回复已变更，请查看最新回复后再反馈'));
        if (err.code === 'P0429')
          return reply
            .header('Retry-After', '60')
            .code(429)
            .send(fail('RATE_LIMITED', '操作有点频繁，请稍后再试'));
      }
      // The repository strips PostgREST detail, which can contain private feedback text.
      log.sys.error(
        { err: err instanceof ChatFeedbackError ? err : new Error('Chat feedback request failed') },
        'feedback request failed'
      );
      return reply
        .code(503)
        .send(fail('SERVICE_UNAVAILABLE', '反馈暂未保存，请重试，填写的内容还在'));
    } finally {
      log.biz.info(
        {
          action: write ? 'save' : 'read',
          status: reply.statusCode,
          elapsedMs: performance.now() - started,
        },
        'chat feedback'
      );
    }
  }
  // @frontend-ready: true — only loaded when the feedback sheet opens.
  app.get(
    '/api/v1/conversations/:id/messages/:messageId/feedback',
    { preHandler: [requireTelegramAuth] },
    handle
  );
  // @frontend-ready: true — reasons/detail are both optional; database deduplicates the reply version.
  app.put(
    '/api/v1/conversations/:id/messages/:messageId/feedback',
    { preHandler: [requireTelegramAuth], bodyLimit: 8192 },
    handle
  );
}
