import type { FastifyInstance } from 'fastify';
import {
  LobbyRecommendationExposuresSchema,
  LobbyRecommendationRequestSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  getLobbyRecommendation,
  reportLobbyRecommendationExposures,
} from '../features/lobby/recommendation.js';

export default async function lobbyRecommendationRoutes(app: FastifyInstance) {
  const options = { preHandler: [requireTelegramAuth] };
  // @frontend-ready: true — authenticated order IDs are projected onto the existing public catalog.
  app.post('/api/characters/recommendation', options, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!request.user) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
    const parsed = LobbyRecommendationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('BAD_REQUEST', '推荐请求无效'));
    const started = performance.now();
    try {
      const user = await getOrCreateDbUser(request.user);
      const data = await getLobbyRecommendation(user.id, parsed.data, request.log);
      request.log.info(
        {
          kind: 'biz',
          event: 'lobby_rotation.resolved',
          action: parsed.data.action,
          enabled: data.enabled,
          degraded: data.degraded,
          headCount: data.head_ids.length,
          durationMs: Math.round(performance.now() - started),
        },
        '大厅推荐批次'
      );
      return reply.send(ok(data));
    } catch (err) {
      request.log.warn(
        {
          kind: 'sys',
          event: 'lobby_rotation.failed',
          err,
          durationMs: Math.round(performance.now() - started),
        },
        '推荐换批失败，客户端保留当前批次'
      );
      return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '暂时没换成功，原来的推荐还在'));
    }
  });
  // @frontend-ready: true — one bounded batch, never one HTTP request per character card.
  app.post('/api/characters/recommendation/exposures', options, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!request.user) return reply.code(401).send(fail('UNAUTHORIZED', '请重新打开小程序'));
    const parsed = LobbyRecommendationExposuresSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('BAD_REQUEST', '曝光请求无效'));
    try {
      const user = await getOrCreateDbUser(request.user);
      const accepted = await reportLobbyRecommendationExposures(user.id, parsed.data, request.log);
      request.log.info(
        {
          kind: 'biz',
          event: 'lobby_rotation.exposures',
          accepted,
          submittedCount: parsed.data.character_ids.length,
        },
        '推荐实际曝光'
      );
      return reply.send(ok({ accepted }));
    } catch (err) {
      request.log.warn(
        { kind: 'sys', event: 'lobby_rotation.exposure_failed', err },
        '曝光记录失败，不影响浏览'
      );
      return reply.code(503).send(fail('SERVICE_UNAVAILABLE', '记录暂不可用'));
    }
  });
}
