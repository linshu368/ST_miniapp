import {
  fail,
  ok,
  VideoPlazaPlaybackObservationSchema,
  type GetVideoPlazaPlaybackData,
  type GetVideoPlazaDownloadData,
} from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';
import { getAccessibleVideoArtifact } from '../features/image-plaza/video-artifact-access.js';
import { signPrivateVideoPath } from '../features/image-plaza/storage.js';
import {
  getStreamDownload,
  signPlazaStreamPlayback,
} from '../features/image-plaza/video-stream-playback.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { observation } from '../platform/observability/runtime.js';
import { routeError } from './image-plaza-errors.js';
import { UUID_PATTERN, userContext } from './image-plaza-helpers.js';

export function registerVideoPlazaPlaybackRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get(
    '/api/image-plaza/video-artifacts/:artifactId/playback',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const user = await userContext(request, reply);
      if (!user) return;
      const { artifactId } = request.params as { artifactId: string };
      if (!UUID_PATTERN.test(artifactId))
        return reply.code(400).send(fail('BAD_REQUEST', '视频 ID 无效'));
      try {
        const artifact = await getAccessibleVideoArtifact(artifactId, user.id);
        if (!artifact) return reply.code(404).send(fail('NOT_FOUND', '视频不存在'));
        const result = await observation.observe(
          'video.delivery.playback',
          async () => ({
            artifact_id: artifact.id,
            playback: await signPlazaStreamPlayback(artifact.streamUid),
            poster_url: artifact.posterPath
              ? await signPrivateVideoPath(artifact.posterPath)
              : null,
          }),
          () => ({ provider: 'cloudflare' })
        );
        return reply.send(ok<GetVideoPlazaPlaybackData>(result));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/video-artifacts/:artifactId/download',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const user = await userContext(request, reply);
      if (!user) return;
      const { artifactId } = request.params as { artifactId: string };
      if (!UUID_PATTERN.test(artifactId))
        return reply.code(400).send(fail('BAD_REQUEST', '视频 ID 无效'));
      try {
        const artifact = await getAccessibleVideoArtifact(artifactId, user.id);
        if (!artifact) return reply.code(404).send(fail('NOT_FOUND', '视频不存在'));
        const data = await observation.observe(
          'video.delivery.download',
          () => getStreamDownload(artifact.streamUid),
          (data) => ({
            provider: 'cloudflare',
            outcome:
              data.status === 'failed'
                ? 'failed'
                : data.status === 'processing'
                  ? 'pending'
                  : 'succeeded',
          })
        );
        return reply.send(ok<GetVideoPlazaDownloadData>(data));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/image-plaza/playback-observations',
    {
      preHandler: [requireTelegramAuth],
      bodyLimit: 2048,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = await userContext(request, reply);
      if (!user) return;
      const body = VideoPlazaPlaybackObservationSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(fail('BAD_REQUEST', '播放观测无效'));
      try {
        const artifact = await getAccessibleVideoArtifact(body.data.artifact_id, user.id);
        if (!artifact) return reply.code(404).send(fail('NOT_FOUND', '视频不存在'));
        observation.emit('video.playback.observation', 'video.delivery.playback', {
          provider: 'cloudflare',
          stage: body.data.stage,
          outcome: body.data.outcome,
          duration_ms: body.data.duration_ms,
          count: body.data.count,
          outcome_known: true,
        });
        return reply.code(202).send(ok({ accepted: true }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );
}
