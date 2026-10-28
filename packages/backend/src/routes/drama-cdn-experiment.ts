import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DRAMA_CDN_SAMPLE_ID,
  DramaCdnPlaybackQuerySchema,
  fail,
  ok,
  type GetDramaByIdData,
  type GetDramaPlaybackData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getDramaCdnExperimentConfig } from '../platform/runtime-config.js';
import { DramaCdnExperiment } from '../features/drama/cdn-experiment.js';

export default async function dramaCdnExperimentRoutes(app: FastifyInstance) {
  const experiment = new DramaCdnExperiment();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    const cfg = getDramaCdnExperimentConfig();
    if (!cfg.enabled) return reply.status(404).send(fail('NOT_FOUND', '实验未开放'));
    await requireTelegramAuth(request, reply);
    if (reply.sent) return;
    if (!request.user || !cfg.userIds.includes(request.user.id))
      return reply.status(403).send(fail('FORBIDDEN', '仅限本轮内部账号'));
  };
  // @frontend-ready: true — fixed sample manifest, no TEST or production database access
  app.get('/api/drama-cdn-experiment/sample', { preHandler: authorize }, async (_request, reply) =>
    reply.send(
      ok<GetDramaByIdData>({
        drama: {
          id: DRAMA_CDN_SAMPLE_ID,
          title: '内部 CDN 配对样本',
          cover_url: null,
          tags: [],
          description: '同一份 46,518,538 字节 MP4',
          episode_count: 1,
          duration_seconds: null,
          videos: [
            {
              id: DRAMA_CDN_SAMPLE_ID,
              title: '配对样本',
              tags: [],
              description: '',
              episode: '1',
              playable: true,
            },
          ],
        },
      })
    )
  );
  // @frontend-ready: true — account + exact sample + expiry enforced on the server
  app.get('/api/drama-cdn-experiment/play', { preHandler: authorize }, async (request, reply) => {
    const parsed = DramaCdnPlaybackQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.status(400).send(fail('BAD_REQUEST', '仅允许本轮固定样本与路径'));
    const cfg = getDramaCdnExperimentConfig();
    if (
      parsed.data.route === 'bunny' &&
      (!Number.isFinite(cfg.deadlineMs) || Date.now() >= cfg.deadlineMs)
    )
      return reply.status(410).send(fail('EXPERIMENT_EXPIRED', '实验已截止，请重新获取原地址'));
    const playback = experiment.playback(cfg, parsed.data.route);
    if (!playback)
      return reply
        .status(410)
        .send(fail('EXPERIMENT_EXPIRED', '源地址已失效，请从原鉴权入口重新获取原地址'));
    request.log.info(
      {
        event: 'drama.cdn_experiment_address',
        route: parsed.data.route,
        video_id: DRAMA_CDN_SAMPLE_ID,
        expires_at: playback.expires_at,
      },
      'experiment address issued'
    );
    return reply.send(ok<GetDramaPlaybackData>({ playback }));
  });
}
