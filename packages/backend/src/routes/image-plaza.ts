import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateImagePlazaConversationRequestSchema,
  IMAGE_PLAZA_PAGE_SIZE,
  IMAGE_PLAZA_INVALID_CURSOR,
  ImagePlazaFeedQuerySchema,
  ImagePlazaQuoteRequestSchema,
  SetImagePlazaLikeRequestSchema,
  ShareImagePlazaWorkRequestSchema,
  SubmitImagePlazaAttemptRequestSchema,
  UploadImagePlazaReferenceRequestSchema,
  VideoPlazaQuoteRequestSchema,
  SubmitVideoPlazaAttemptRequestSchema,
  ShareVideoPlazaWorkRequestSchema,
  VideoPlazaTagCountsQuerySchema,
  fail,
  ok,
  type CreateImagePlazaConversationData,
  type GetImagePlazaConfigData,
  type GetImagePlazaConversationData,
  type GetImagePlazaConversationsData,
  type GetImagePlazaFeedData,
  type GetImagePlazaWorkData,
  type ImagePlazaQuoteData,
  type SetImagePlazaLikeData,
  type ShareImagePlazaWorkData,
  type SubmitImagePlazaAttemptData,
  type UploadImagePlazaReferenceData,
  type VideoPlazaQuoteData,
  type SubmitVideoPlazaAttemptData,
  type GetVideoPlazaAttemptData,
  type GetVideoPlazaPlaybackData,
  type ShareVideoPlazaWorkData,
  type GetVideoPlazaTagCountsData,
} from '@miniapp/shared';
import {
  getImagePlazaRuntimeConfig,
  publicImagePlazaFeedTags,
} from '../features/image-plaza/config.js';
import { ImagePlazaRepository } from '../features/image-plaza/repository.js';
import { VideoPlazaRepository } from '../features/image-plaza/video-repository.js';
import { classifyImagePlazaTags, waitForImagePlazaTags } from '../features/image-plaza/tagging.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { config } from '../platform/config.js';
import { isVideoMediaAvailable } from '../features/image-plaza/video-media.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tagCountCache = new Map<string, { expiresAt: number; counts: Record<string, number> }>();

export default async function imagePlazaRoutes(app: FastifyInstance) {
  const repository = new ImagePlazaRepository();
  let videoRepository: VideoPlazaRepository | null = null;
  const videos = () => (videoRepository ??= new VideoPlazaRepository());

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      try {
        const runtime = await getImagePlazaRuntimeConfig();
        return reply.send(
          ok<GetImagePlazaConfigData>({
            enabled: runtime.enabled,
            video_models:
              isVideoMediaAvailable() && config.imagePlaza.videoWorkerEnabled
                ? (runtime.videoCatalog?.models
                    .filter((model) => model.enabled)
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map(
                      ({
                        provider_ids: _providerIds,
                        enabled: _enabled,
                        sort_order: _sort,
                        price_matrix: _prices,
                        seed_aliases: _aliases,
                        ...model
                      }) => model
                    ) ?? [])
                : [],
            default_video_model_id:
              isVideoMediaAvailable() && config.imagePlaza.videoWorkerEnabled
                ? (runtime.videoCatalog?.default_model_id ?? null)
                : null,
            models: runtime.catalog.models
              .filter((model) => model.enabled)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map(
                ({
                  provider_model_id: _providerId,
                  edit_provider_model_id: _editProviderId,
                  sizing_mode: _sizingMode,
                  enabled: _enabled,
                  sort_order: _sort,
                  internal_tags: _tags,
                  ...model
                }) => model
              ),
            tags: publicImagePlazaFeedTags(runtime),
            share_tip: runtime.shareTip,
            share_rebate_rate: runtime.rebateRate,
            has_completed_first_share: await repository.hasCompletedFirstShare(context.id),
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/feed',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      try {
        const parsed = ImagePlazaFeedQuerySchema.safeParse(request.query);
        if (!parsed.success) return reply.status(400).send(fail('BAD_REQUEST', '广场查询参数无效'));
        const query = parsed.data;
        const startedAt = performance.now();
        const runtime = await getImagePlazaRuntimeConfig();
        const tagId = typeof query.tag === 'string' && query.tag !== 'all' ? query.tag : undefined;
        const tagIds = [
          ...(tagId ? [tagId] : []),
          ...(query.tags ? query.tags.split(',').map((tag) => tag.trim()) : []),
        ].filter((tag, index, all) => all.indexOf(tag) === index);
        const search =
          typeof query.search === 'string' ? query.search.trim().slice(0, 80) : undefined;
        const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
        // 「全部」或不传 tag：不做标签限制。业务 tag 校验目录后按中文 label 筛 prompt_zh。
        const tagConfigs = tagIds.map((id) =>
          runtime.tags.find((item) => item.enabled && item.id === id)
        );
        if (tagConfigs.some((item) => !item)) {
          return reply.status(400).send(fail('BAD_REQUEST', '标签无效'));
        }
        const tagConfig = tagConfigs.length === 1 ? tagConfigs[0] : undefined;
        const media = query.media ?? 'all';
        if (media !== 'all' && tagConfigs.some((item) => !item?.media_types.includes(media)))
          return reply.status(400).send(fail('BAD_REQUEST', '标签不适用于当前媒体类型'));
        const page = await repository.listWorks({
          userId: context.id,
          ...(search ? { search } : {}),
          ...(tagConfig && !query.tags && media !== 'video' ? { tagLabel: tagConfig.label } : {}),
          ...(query.tags || media === 'video' || tagIds.length > 1 ? { tagIds } : {}),
          ...(query.media ? { media } : {}),
          ...(cursor ? { cursor } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          limit: IMAGE_PLAZA_PAGE_SIZE,
        });
        request.log.info(
          {
            event: 'image_plaza.feed.completed',
            sort: query.sort ?? 'legacy',
            count: page.works.length,
            hasCursor: Boolean(cursor),
            hasSearch: Boolean(search),
            hasTag: Boolean(tagId),
            durationMs: Math.round(performance.now() - startedAt),
          },
          'Image plaza feed completed'
        );
        return reply.send(
          ok<GetImagePlazaFeedData>({
            items: page.works,
            next_cursor: page.nextCursor,
            tags: publicImagePlazaFeedTags(runtime),
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/works/:workId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { workId } = request.params as { workId: string };
      if (!UUID_PATTERN.test(workId))
        return reply.status(400).send(fail('BAD_REQUEST', '作品 ID 无效'));
      try {
        const work = await repository.getWork(workId, context.id);
        if (!work) return reply.status(404).send(fail('NOT_FOUND', '作品不存在'));
        return reply.send(ok<GetImagePlazaWorkData>({ work }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.put(
    '/api/image-plaza/works/:workId/like',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { workId } = request.params as { workId: string };
      const body = SetImagePlazaLikeRequestSchema.safeParse(request.body);
      if (!UUID_PATTERN.test(workId) || !body.success)
        return reply.status(400).send(fail('BAD_REQUEST', '点赞参数无效'));
      try {
        const startedAt = performance.now();
        const result = await repository.setLike(context.id, workId, body.data.liked);
        request.log.info(
          {
            event: 'image_plaza.like.completed',
            liked: result.liked,
            durationMs: Math.round(performance.now() - startedAt),
          },
          'Image plaza like completed'
        );
        return reply.send(
          ok<SetImagePlazaLikeData>({ liked: result.liked, like_count: result.likeCount })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/image-plaza/quotes',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const body = ImagePlazaQuoteRequestSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(fail('BAD_REQUEST', '报价参数无效'));
      try {
        const runtime = await requireEnabled();
        requireGenerationProvider();
        const model = runtime.catalog.models.find(
          (item) => item.enabled && item.id === body.data.model_id
        );
        if (!model) return reply.status(409).send(fail('MODEL_UNAVAILABLE', '模型已下架'));
        const quote = await repository.createQuote({
          userId: context.id,
          model,
          aspectRatio: body.data.aspect_ratio,
          resolution: body.data.resolution,
          mode: body.data.mode,
          catalogVersion: runtime.catalogVersion,
        });
        return reply.send(
          ok<ImagePlazaQuoteData>({
            quote_id: quote.id,
            model_id: model.id,
            aspect_ratio: body.data.aspect_ratio,
            resolution: body.data.resolution,
            credits: quote.credits,
            expires_at: quote.expiresAt,
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

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
        const tagIds = runtime.tags
          .filter(
            (tag) =>
              tag.enabled &&
              (parsed.data.media === 'all' || tag.media_types.includes(parsed.data.media))
          )
          .map((tag) => tag.id);
        const cacheKey = JSON.stringify([
          parsed.data.media,
          parsed.data.search?.trim().toLocaleLowerCase() ?? '',
          tagIds,
        ]);
        const cached = tagCountCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now())
          return reply.send(ok<GetVideoPlazaTagCountsData>({ counts: cached.counts }));
        const counts = await repository.countWorksByTags({
          tagIds,
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
        const attempt = await videos().createAttempt({
          userId: context.id,
          conversationId,
          body: body.data,
        });
        return reply.status(202).send(ok<SubmitVideoPlazaAttemptData>({ attempt }));
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

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/video-attempts/:attemptId/playback',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { attemptId } = request.params as { attemptId: string };
      if (!UUID_PATTERN.test(attemptId))
        return reply.status(400).send(fail('BAD_REQUEST', '视频任务 ID 无效'));
      try {
        const attempt = await videos().getAttempt(attemptId, context.id);
        if (!attempt?.artifact) return reply.status(404).send(fail('NOT_FOUND', '视频尚未生成'));
        return reply.send(
          ok<GetVideoPlazaPlaybackData>({
            artifact_id: attempt.artifact.id,
            video_url: attempt.artifact.video_url,
            poster_url: attempt.artifact.poster_url,
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

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
        const enabledTags = new Set(
          runtime.tags
            .filter((tag) => tag.enabled && tag.media_types.includes('video'))
            .map((tag) => tag.id)
        );
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
    '/api/image-plaza/references',
    {
      preHandler: [requireTelegramAuth],
      bodyLimit: 29_000_000,
    },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const body = UploadImagePlazaReferenceRequestSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(fail('BAD_REQUEST', '参考图格式无效'));
      try {
        await requireEnabled();
        const artifact = await repository.uploadReference({
          userId: context.id,
          bytes: Buffer.from(
            body.data.image_base64.replace(/^data:image\/[a-z+]+;base64,/, ''),
            'base64'
          ),
          mimeType: body.data.mime_type,
        });
        return reply.send(ok<UploadImagePlazaReferenceData>({ artifact }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/conversations',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      try {
        return reply.send(
          ok<GetImagePlazaConversationsData>({
            conversations: await repository.listConversations(context.id),
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/image-plaza/conversations',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const body = CreateImagePlazaConversationRequestSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send(fail('BAD_REQUEST', '会话参数无效'));
      try {
        await requireEnabled();
        return reply.send(
          ok<CreateImagePlazaConversationData>({
            conversation: await repository.createConversation(context.id, body.data.source_work_id),
          })
        );
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/conversations/:conversationId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { conversationId } = request.params as { conversationId: string };
      if (!UUID_PATTERN.test(conversationId))
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      try {
        const conversation = await repository.getConversation(conversationId, context.id);
        if (!conversation) return reply.status(404).send(fail('NOT_FOUND', '会话不存在'));
        const includeVideo = (request.query as { include_video?: unknown }).include_video === '1';
        const compatible = includeVideo
          ? conversation
          : {
              ...conversation,
              snapshot:
                conversation.snapshot && 'input_mode' in conversation.snapshot
                  ? null
                  : conversation.snapshot,
              messages: conversation.messages.filter((message) => message.media_type !== 'video'),
            };
        return reply.send(ok<GetImagePlazaConversationData>({ conversation: compatible }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/image-plaza/conversations/:conversationId/attempts',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { conversationId } = request.params as { conversationId: string };
      const body = SubmitImagePlazaAttemptRequestSchema.safeParse(request.body);
      if (!UUID_PATTERN.test(conversationId) || !body.success)
        return reply.status(400).send(fail('BAD_REQUEST', '生成参数无效'));
      try {
        const runtime = await requireEnabled();
        requireGenerationProvider();
        const model = runtime.catalog.models.find(
          (item) => item.enabled && item.id === body.data.model_id
        );
        if (!model) return reply.status(409).send(fail('MODEL_UNAVAILABLE', '模型已下架'));
        if (body.data.mode === 'edit' && !model.supports_edit)
          return reply.status(409).send(fail('MODEL_UNAVAILABLE', '模型不支持编辑'));
        const attempt = await repository.createAttempt({
          userId: context.id,
          conversationId,
          body: body.data,
          model,
        });
        return reply.status(202).send(ok<SubmitImagePlazaAttemptData>({ attempt }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/image-plaza/attempts/:attemptId',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const { attemptId } = request.params as { attemptId: string };
      if (!UUID_PATTERN.test(attemptId))
        return reply.status(400).send(fail('BAD_REQUEST', '任务 ID 无效'));
      try {
        const attempt = await repository.getAttempt(attemptId, context.id);
        if (!attempt) return reply.status(404).send(fail('NOT_FOUND', '任务不存在'));
        return reply.send(ok<SubmitImagePlazaAttemptData>({ attempt }));
      } catch (err) {
        return routeError(request, reply, err);
      }
    }
  );

  // @frontend-ready: true
  app.post(
    '/api/image-plaza/share',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      const body = ShareImagePlazaWorkRequestSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(fail('BAD_REQUEST', '分享参数无效'));
      try {
        const runtime = await requireEnabled();
        const enabledTags = new Set(runtime.tags.filter((tag) => tag.enabled).map((tag) => tag.id));
        if (body.data.tags.some((tag) => !enabledTags.has(tag)))
          return reply.status(400).send(fail('BAD_REQUEST', '作品标签无效'));
        const modelId = await repository.getArtifactModelId(body.data.artifact_id, context.id);
        const modelName =
          runtime.catalog.models.find((model) => model.id === modelId)?.name ?? modelId;
        const taggingStartedAt = Date.now();
        // 标签功能关时跳过自动打标；客户端显式传 tags 仍按启用集合校验后写入。
        const pendingTags =
          body.data.tags.length === 0 && runtime.tagsFeatureEnabled
            ? repository
                .loadSharePrompt(body.data.artifact_id, context.id)
                .then((prompt) =>
                  classifyImagePlazaTags({ prompt, tags: runtime.tags, log: request.log })
                )
                .catch(() => {
                  request.log.warn(
                    {
                      event: 'image_plaza.tagging.failed',
                      err: new Error('image_plaza_tagging_prompt_unavailable'),
                      durationMs: Date.now() - taggingStartedAt,
                    },
                    'Image plaza tagging prompt unavailable'
                  );
                  return [];
                })
            : null;
        const classifiedTags = pendingTags ? await waitForImagePlazaTags(pendingTags) : null;
        const deferred = pendingTags !== null && classifiedTags === null;
        if (pendingTags) {
          request.log.info(
            {
              event: 'image_plaza.tagging.share_ready',
              artifactId: body.data.artifact_id,
              mode: deferred ? 'async' : 'sync',
              durationMs: Date.now() - taggingStartedAt,
              tagCount: classifiedTags?.length ?? 0,
            },
            'Image plaza share tagging ready'
          );
        }
        const result = await repository.shareArtifact({
          userId: context.id,
          artifactId: body.data.artifact_id,
          title: body.data.title,
          modelName,
          tags: pendingTags ? (classifiedTags ?? []) : body.data.tags,
          rebateRate: runtime.rebateRate,
        });
        // 重复分享保留首次快照；仅新分享允许续接同一次分类结果，不重复触发返利。
        if (deferred && pendingTags && !result.alreadyShared) {
          void pendingTags
            .then(async (tags) => {
              if (tags.length === 0) return;
              const updated = await repository.updateWorkTagsIfEmpty(
                result.workId,
                context.id,
                tags
              );
              request.log.info(
                {
                  event: 'image_plaza.tagging.backfilled',
                  workId: result.workId,
                  updated,
                  tagCount: tags.length,
                  durationMs: Date.now() - taggingStartedAt,
                },
                'Image plaza work tagging backfill completed'
              );
            })
            .catch((err: unknown) => {
              request.log.warn(
                { err, event: 'image_plaza.tagging.backfill_failed', workId: result.workId },
                'Image plaza work tagging backfill failed'
              );
            });
        }
        const work = await repository.getWork(result.workId, context.id);
        if (!work || work.media_type !== 'image')
          throw new Error('image_plaza_shared_work_missing');
        return reply.send(
          ok<ShareImagePlazaWorkData>({
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
}

async function userContext(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    return null;
  }
  return getOrCreateDbUser(request.user);
}

async function requireEnabled() {
  const runtime = await getImagePlazaRuntimeConfig();
  if (!runtime.enabled) throw new Error('image_plaza_disabled');
  return runtime;
}

function requireGenerationProvider(): void {
  // 没有 worker 或 provider key 时任务必然失败，必须在写消息/attempt 前同步拒绝。
  if (!config.imagePlaza.workerEnabled || !config.imagePlaza.apiKey) {
    throw new Error('image_plaza_provider_unavailable');
  }
}

function requireVideoGenerationProvider(): void {
  if (
    !config.imagePlaza.videoWorkerEnabled ||
    !config.imagePlaza.apiKey ||
    !isVideoMediaAvailable()
  )
    throw new Error('video_plaza_provider_unavailable');
}

function routeError(request: FastifyRequest, reply: FastifyReply, err: unknown) {
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
  if (message.includes('too_many_active'))
    return reply.status(429).send(fail('TOO_MANY_ACTIVE_VIDEO_ATTEMPTS', '最多同时生成两个视频'));
  if (message.includes('not_found')) return reply.status(404).send(fail('NOT_FOUND', '内容不存在'));
  if (
    message.includes('disabled') ||
    message.includes('config_invalid') ||
    message.includes('provider_unavailable')
  )
    return reply.status(503).send(fail('IMAGE_PLAZA_UNAVAILABLE', '图片创作暂不可用'));
  if (expected)
    return reply.status(409).send(fail('REQUEST_REJECTED', '请求状态已变化，请刷新后重试'));
  return reply.status(500).send(fail('INTERNAL_ERROR', '请求失败，请稍后重试'));
}
