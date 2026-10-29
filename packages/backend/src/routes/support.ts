import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { fail, MAX_SUPPORT_IMAGE_BYTES, type SendSupportMessageRequest } from '@miniapp/shared';
import { callCsService, CS_SERVICE_IMAGE_TIMEOUT_MS } from '../lib/cs-service.js';
import { requestLogger } from '../lib/logger.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth, type TelegramUser } from '../middleware/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** 图片按 base64 放在 JSON 里，比原图大三分之一，再留一点余量 */
const IMAGE_BODY_LIMIT = Math.ceil((MAX_SUPPORT_IMAGE_BYTES * 4) / 3) + 64 * 1024;
type SupportOperation = 'conversation' | 'unread' | 'read' | 'messages.read' | 'messages.send';

/**
 * App「联系客服」的接口。客服业务在独立服务（linshu368/ST_cs_platform），
 * 这里只负责 Telegram 鉴权，鉴权通过后按用户把请求代理过去，响应形状和状态码原样透传。
 */
export default async function supportRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get(
    '/api/support/conversation',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      return proxyToCs(
        reply,
        request.log,
        request.user,
        'conversation',
        'GET',
        (userId) => `/internal/app/users/${userId}/conversation`
      );
    }
  );

  // 「我的」页和底部导航的客服红点都读这里，判定完全在服务端，多端进出不会各自算出不同结果。
  // @frontend-ready: true
  app.get('/api/support/unread', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    return proxyToCs(
      reply,
      request.log,
      request.user,
      'unread',
      'GET',
      (userId) => `/internal/app/users/${userId}/unread`
    );
  });

  // 进入客服聊天页即视为读过；聊天页开着又来新回复时会再调一次，推进水位线。
  // @frontend-ready: true
  app.post('/api/support/read', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    return proxyToCs(
      reply,
      request.log,
      request.user,
      'read',
      'POST',
      (userId) => `/internal/app/users/${userId}/read`
    );
  });

  // @frontend-ready: true
  app.get(
    '/api/support/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { after } = request.query as { after?: string };
      const query = after ? `?after=${encodeURIComponent(after)}` : '';
      return proxyToCs(
        reply,
        request.log,
        request.user,
        'messages.read',
        'GET',
        (userId) => `/internal/app/users/${userId}/messages${query}`
      );
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/support/messages',
    { preHandler: [requireTelegramAuth], bodyLimit: IMAGE_BODY_LIMIT },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const body = (request.body ?? {}) as Partial<SendSupportMessageRequest>;
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      const imageData = body.image?.data_base64;
      if (
        body.image !== undefined &&
        (typeof imageData !== 'string' || !BASE64_RE.test(imageData))
      ) {
        return reply.status(400).send(fail('INVALID_IMAGE', '图片无效'));
      }
      if (
        (!text && !imageData) ||
        text.length > 4000 ||
        !body.client_msg_id ||
        !UUID_RE.test(body.client_msg_id)
      ) {
        return reply.status(400).send(fail('INVALID_MESSAGE', '消息内容或请求标识无效'));
      }

      // 图片的格式和大小由客服服务按文件头校验，这里只做形状检查
      return proxyToCs(
        reply,
        request.log,
        request.user,
        'messages.send',
        'POST',
        (userId) => `/internal/app/users/${userId}/messages`,
        {
          body: text,
          client_msg_id: body.client_msg_id,
          ...(imageData ? { image: { data_base64: imageData } } : {}),
        },
        imageData ? CS_SERVICE_IMAGE_TIMEOUT_MS : undefined
      );
    }
  );
}

/** 客服服务的响应形状与旧接口逐字段一致（见 ST_cs_platform contracts/app.ts），状态码和信封原样透传 */
async function proxyToCs(
  reply: FastifyReply,
  baseLog: FastifyBaseLogger,
  telegramUser: TelegramUser,
  operation: SupportOperation,
  method: 'GET' | 'POST',
  pathForUser: (userId: string) => string,
  body?: unknown,
  timeoutMs?: number
): Promise<FastifyReply> {
  const log = requestLogger(baseLog, 'support');
  const startedAt = performance.now();
  let identityMs: number | undefined;

  try {
    const user = await getOrCreateDbUser(telegramUser);
    identityMs = Math.round(performance.now() - startedAt);
    const upstreamStartedAt = performance.now();
    const { status, payload } = await callCsService(method, pathForUser(user.id), body, timeoutMs);
    const upstreamMs = Math.round(performance.now() - upstreamStartedAt);
    log.biz.info(
      {
        event: 'support.proxy.completed',
        operation,
        status,
        identityMs,
        upstreamMs,
        totalMs: Math.round(performance.now() - startedAt),
      },
      '客服代理请求完成'
    );
    return reply.status(status).send(payload);
  } catch (err) {
    log.sys.error(
      {
        err,
        event: 'support.proxy.failed',
        operation,
        identityMs,
        totalMs: Math.round(performance.now() - startedAt),
      },
      '客服代理请求失败'
    );
    throw err;
  }
}
