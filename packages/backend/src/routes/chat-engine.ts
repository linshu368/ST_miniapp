import type { FastifyInstance } from 'fastify';
import { ok, type GetChatEngineData } from '@miniapp/shared';

import { getChatEngineSetting } from '../platform/chat-engine.js';

export default async function chatEngineRoutes(app: FastifyInstance) {
  // 不鉴权：与 /api/platform/models 同级的平台配置，且客户端要在登录链路之前
  // 就知道该不该挂 ST iframe。响应不缓存，回滚才能靠一次刷新生效。
  // @frontend-ready: true
  app.get('/api/platform/chat-engine', async (_request, reply) => {
    const setting = await getChatEngineSetting();
    reply.header('Cache-Control', 'no-store');
    return reply.send(ok<GetChatEngineData>(setting));
  });
}
