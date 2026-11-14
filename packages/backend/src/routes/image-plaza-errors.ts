import type { FastifyReply, FastifyRequest } from 'fastify';
import { fail, IMAGE_PLAZA_INVALID_CURSOR } from '@miniapp/shared';

export function routeError(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : 'image plaza request failed';
  if (message === IMAGE_PLAZA_INVALID_CURSOR) {
    request.log.warn({ event: 'image_plaza.cursor_rejected' }, 'Image plaza cursor rejected');
    return reply.status(400).send(fail(IMAGE_PLAZA_INVALID_CURSOR, '分页已失效，请刷新广场'));
  }
  const expected =
    /(?:not_found|expired|mismatch|conflict|invalid|insufficient|unavailable|disabled|does_not_support)/.test(
      message
    );
  request.log[expected ? 'warn' : 'error'](
    { err, event: 'image_plaza.request_failed' },
    'Image plaza request failed'
  );
  if (message.includes('insufficient_balance'))
    return reply.status(402).send(fail('INSUFFICIENT_BALANCE', '星尘不足'));
  if (message.includes('not_found')) return reply.status(404).send(fail('NOT_FOUND', '内容不存在'));
  if (
    message.includes('disabled') ||
    message.includes('config_invalid') ||
    message.includes('provider_unavailable')
  )
    return reply.status(503).send(fail('IMAGE_PLAZA_UNAVAILABLE', '图片创作暂时用不了'));
  if (expected)
    return reply.status(409).send(fail('REQUEST_REJECTED', '请求状态已变化，请刷新后重试'));
  return reply.status(500).send(fail('INTERNAL_ERROR', '请求失败，请稍后重试'));
}
