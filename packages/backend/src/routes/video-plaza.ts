import { registerVideoPlazaPlaybackRoutes } from './video-plaza-playback.js';
import {
  ShareVideoPlazaWorkRequestSchema,
  SubmitVideoPlazaAttemptRequestSchema,
  VideoPlazaQuoteRequestSchema,
  VideoPlazaTagCountsQuerySchema,
  fail,
  ok,
  type CreateVideoReferenceFromImageArtifactData,
  type GetVideoPlazaAttemptData,
  type GetVideoPlazaTagCountsData,
  type ShareVideoPlazaWorkData,
  type SubmitVideoPlazaAttemptData,
  type VideoPlazaQuoteData,
} from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';
import { getImagePlazaRuntimeConfig } from '../features/image-plaza/config.js';
import { ImagePlazaRepository } from '../features/image-plaza/repository.js';
import { wakeVideoPlazaGenerationJob } from '../features/image-plaza/video-job.js';
import { VideoPlazaRepository } from '../features/image-plaza/video-repository.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { routeError } from './image-plaza-errors.js';

import {
  UUID_PATTERN,
  requireEnabled,
  requireVideoGenerationProvider,
  userContext,
} from './image-plaza-helpers.js';

const tagCountCache = new Map<string, { expiresAt: number; counts: Record<string, number> }>();

export function registerVideoPlazaQuoteRoutes(
  app: FastifyInstance,
  repository: ImagePlazaRepository,
  videos: () => VideoPlazaRepository
) {
  // @frontend-ready: true
  app.post(
    '/api/image-plaza/video-quotes',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const body = VideoPlazaQuoteRequestSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(fail('BAD_REQUEST', '视频报价参数无效'));
      try {
        const runtime = await requireEnabled();
        requireVideoGenerationProvider();
        const model = runtime.videoCatalog?.models.find(
          (item) => item.enabled && item.id === body.data.model_id
        );
        if (!model) return reply.status(409).send(fail('MODEL_UNAVAILABLE', '视频模型已下架'));
        const aspectValid =
          model.aspect_ratios.length === 0
            ? body.data.aspect_ratio === null
            : body.data.aspect_ratio !== null &&
              model.aspect_ratios.includes(body.data.aspect_ratio);
        if (
          !model.provider_ids[body.data.input_mode] ||
          !model.durations.includes(body.data.duration_s) ||
          !model.resolutions.includes(body.data.resolution) ||
          !aspectValid ||
          (!model.audio_configurable && body.data.audio !== model.default_audio)
        ) {
          return reply.status(400).send(fail('BAD_REQUEST', '视频模型参数组合无效'));
        }
        const quote = await videos().createQuote({
          userId: context.id,
          model,
          inputMode: body.data.input_mode,
          duration: body.data.duration_s,
          resolution: body.data.resolution,
          aspectRatio: body.data.aspect_ratio,
          audio: body.data.audio,
          catalogVersion: runtime.videoCatalogVersion,
        });
        return reply.send(ok<VideoPlazaQuoteData>(quote));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/feed/tag-counts',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const parsed = VideoPlazaTagCountsQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send(fail('BAD_REQUEST', '标签计数参数无效'));
      try {
        const runtime = await getImagePlazaRuntimeConfig();
        const tags = runtime.tags
          .filter((tag) => tag.enabled)
          .map(({ id, label }) => ({ id, label }));
        const cacheKey = JSON.stringify([
          parsed.data.media,
          parsed.data.search?.trim().toLocaleLowerCase() ?? '',
          tags,
        ]);
        const cached = tagCountCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now())
          return reply.send(ok<GetVideoPlazaTagCountsData>({ counts: cached.counts }));
        const counts = await repository.countWorksByTags({
          tags,
          media: parsed.data.media,
          ...(parsed.data.search ? { search: parsed.data.search } : {}),
        });
        tagCountCache.set(cacheKey, { expiresAt: Date.now() + 60_000, counts });
        if (tagCountCache.size > 100) tagCountCache.delete(tagCountCache.keys().next().value ?? '');
        return reply.send(ok<GetVideoPlazaTagCountsData>({ counts }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );
}

export function registerVideoPlazaAttemptRoutes(
  app: FastifyInstance,
  repository: ImagePlazaRepository,
  videos: () => VideoPlazaRepository
) {
  registerVideoPlazaPlaybackRoutes(app);
  // @frontend-ready: true
  app.post(
    '/api/image-plaza/conversations/:conversationId/video-attempts',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { conversationId } = request.params as { conversationId: string };
      const body = SubmitVideoPlazaAttemptRequestSchema.safeParse(request.body);
      if (!UUID_PATTERN.test(conversationId) || !body.success)
        return reply.status(400).send(fail('BAD_REQUEST', '视频生成参数无效'));
      try {
        const runtime = await requireEnabled();
        requireVideoGenerationProvider();
        if (!runtime.videoCatalog)
          return reply.status(503).send(fail('VIDEO_PLAZA_UNAVAILABLE', '视频创作暂不可用'));
        const result = await videos().createAttempt({
          userId: context.id,
          conversationId,
          body: body.data,
        });
        wakeVideoPlazaGenerationJob();
        return reply.status(202).send(ok<SubmitVideoPlazaAttemptData>(result));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/video-attempts/:attemptId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { attemptId } = request.params as { attemptId: string };
      if (!UUID_PATTERN.test(attemptId))
        return reply.status(400).send(fail('BAD_REQUEST', '视频任务 ID 无效'));
      try {
        const attempt = await videos().getAttempt(attemptId, context.id);
        if (!attempt) return reply.status(404).send(fail('NOT_FOUND', '视频任务不存在'));
        return reply.send(ok<GetVideoPlazaAttemptData>({ attempt }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );
}

export function registerVideoPlazaShareRoutes(
  app: FastifyInstance,
  repository: ImagePlazaRepository,
  videos: () => VideoPlazaRepository
) {
  // @frontend-ready: true
  app.post(
    '/api/image-plaza/video-share',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const body = ShareVideoPlazaWorkRequestSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(fail('BAD_REQUEST', '视频分享参数无效'));
      try {
        const runtime = await requireEnabled();
        const enabledTags = new Set(runtime.tags.filter((tag) => tag.enabled).map((tag) => tag.id));
        if (body.data.tags.some((tag) => !enabledTags.has(tag)))
          return reply.status(400).send(fail('BAD_REQUEST', '视频标签无效'));
        const modelId = await videos().getArtifactModelId(body.data.artifact_id, context.id);
        const modelName =
          runtime.videoCatalog?.models.find((model) => model.id === modelId)?.name ?? modelId;
        const result = await videos().share({
          userId: context.id,
          artifactId: body.data.artifact_id,
          title: body.data.title,
          description: body.data.description,
          modelName,
          tags: body.data.tags,
          rebateRate: runtime.rebateRate,
        });
        const work = await repository.getWork(result.workId, context.id);
        if (!work || work.media_type !== 'video')
          throw new Error('video_plaza_shared_work_missing');
        return reply.send(
          ok<ShareVideoPlazaWorkData>({
            work,
            already_shared: result.alreadyShared,
            reward_credits: result.rewardCredits,
            has_completed_first_share: true,
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/image-plaza/image-artifacts/:artifactId/video-reference',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { artifactId } = request.params as { artifactId: string };
      if (!UUID_PATTERN.test(artifactId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '图片产物 ID 无效'));
      }
      try {
        await requireEnabled();
        const artifact = await repository.createVideoReferenceFromImageArtifact(
          artifactId,
          context.id
        );
        return reply.send(ok<CreateVideoReferenceFromImageArtifactData>({ artifact }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );
}
