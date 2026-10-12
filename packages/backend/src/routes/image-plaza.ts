import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateImagePlazaConversationRequestSchema,
  IMAGE_PLAZA_PAGE_SIZE,
  ImagePlazaQuoteRequestSchema,
  SetImagePlazaLikeRequestSchema,
  ShareImagePlazaWorkRequestSchema,
  SubmitImagePlazaAttemptRequestSchema,
  UploadImagePlazaReferenceRequestSchema,
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
} from '@miniapp/shared';
import { getImagePlazaRuntimeConfig } from '../features/image-plaza/config.js';
import { ImagePlazaRepository } from '../features/image-plaza/repository.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function imagePlazaRoutes(app: FastifyInstance) {
  const repository = new ImagePlazaRepository();

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
            tags: [
              { id: 'all', label: '全部' },
              ...runtime.tags
                .filter((tag) => tag.enabled)
                .sort((a, b) => a.sort_order - b.sort_order)
                .map(({ id, label }) => ({ id, label })),
            ],
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
        const query = request.query as Record<string, unknown>;
        const runtime = await getImagePlazaRuntimeConfig();
        const tag = typeof query.tag === 'string' && query.tag !== 'all' ? query.tag : undefined;
        const search =
          typeof query.search === 'string' ? query.search.trim().slice(0, 80) : undefined;
        const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
        if (tag && !runtime.tags.some((item) => item.enabled && item.id === tag)) {
          return reply.status(400).send(fail('BAD_REQUEST', '标签无效'));
        }
        const page = await repository.listWorks({
          userId: context.id,
          ...(search ? { search } : {}),
          ...(tag ? { tag } : {}),
          ...(cursor ? { cursor } : {}),
          limit: IMAGE_PLAZA_PAGE_SIZE,
        });
        return reply.send(
          ok<GetImagePlazaFeedData>({
            items: page.works,
            next_cursor: page.nextCursor,
            tags: [
              { id: 'all', label: '全部' },
              ...runtime.tags
                .filter((item) => item.enabled)
                .sort((a, b) => a.sort_order - b.sort_order)
                .map(({ id, label }) => ({ id, label })),
            ],
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
        const result = await repository.setLike(context.id, workId, body.data.liked);
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
        return reply.send(ok<GetImagePlazaConversationData>({ conversation }));
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
        const result = await repository.shareArtifact({
          userId: context.id,
          artifactId: body.data.artifact_id,
          title: body.data.title,
          modelName,
          tags: body.data.tags,
          rebateRate: runtime.rebateRate,
        });
        const work = await repository.getWork(result.workId, context.id);
        if (!work) throw new Error('image_plaza_shared_work_missing');
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

function routeError(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  const message = err instanceof Error ? err.message : 'image plaza request failed';
  const expected =
    /(?:not_found|expired|mismatch|conflict|invalid|insufficient|unavailable|disabled|does_not_support)/.test(
      message
    );
  request.log[expected ? 'warn' : 'error'](
    { err, event: 'image_plaza.request_failed' },
    'Image plaza request failed'
  );
  if (message.includes('insufficient_balance'))
    return reply.status(409).send(fail('INSUFFICIENT_BALANCE', '星尘不足'));
  if (message.includes('not_found')) return reply.status(404).send(fail('NOT_FOUND', '内容不存在'));
  if (message.includes('disabled') || message.includes('config_invalid'))
    return reply.status(503).send(fail('IMAGE_PLAZA_UNAVAILABLE', '图片创作暂不可用'));
  if (expected)
    return reply.status(409).send(fail('REQUEST_REJECTED', '请求状态已变化，请刷新后重试'));
  return reply.status(500).send(fail('INTERNAL_ERROR', '请求失败，请稍后重试'));
}
