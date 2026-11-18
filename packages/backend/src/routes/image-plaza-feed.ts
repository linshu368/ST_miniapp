import {
  IMAGE_PLAZA_PAGE_SIZE,
  ImagePlazaFeedQuerySchema,
  fail,
  ok,
  type GetImagePlazaConfigData,
  type GetImagePlazaFeedData,
} from '@miniapp/shared';
import type { FastifyInstance } from 'fastify';
import {
  getImagePlazaFeedRuntimeConfig,
  publicImagePlazaFeedTags,
} from '../features/image-plaza/config.js';
import { ImagePlazaRepository } from '../features/image-plaza/repository.js';
import { getVideoStreamConfig } from '../platform/runtime-config.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { config } from '../platform/config.js';
import { routeError } from './image-plaza-errors.js';

import { userContext } from './image-plaza-helpers.js';

export function registerImagePlazaConfigRoute(
  app: FastifyInstance,
  repository: ImagePlazaRepository
) {
  // @frontend-ready: true
  app.get(
    '/api/image-plaza/config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      const context = await userContext(request, reply);
      if (!context) return;
      try {
        const runtime = await getImagePlazaFeedRuntimeConfig();
        return reply.send(
          ok<GetImagePlazaConfigData>({
            enabled: runtime.enabled,
            video_models:
              getVideoStreamConfig() !== null && config.imagePlaza.videoWorkerEnabled
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
              getVideoStreamConfig() !== null && config.imagePlaza.videoWorkerEnabled
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
}

export function registerImagePlazaFeedRoute(
  app: FastifyInstance,
  repository: ImagePlazaRepository
) {
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
        const runtime = await getImagePlazaFeedRuntimeConfig();
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
        const tagLabels = tagConfigs.flatMap((item) => (item ? [item.label] : []));
        const media = query.media ?? 'all';
        const page = await repository.listWorks({
          userId: context.id,
          ...(search ? { search } : {}),
          ...(tagLabels.length ? { tagLabels } : {}),
          ...(query.media ? { media } : {}),
          ...(cursor ? { cursor } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          limit: IMAGE_PLAZA_PAGE_SIZE,
        });
        request.log.info(
          {
            event: 'image_plaza.feed.completed',
            outcome: 'succeeded',
            sort: query.sort ?? 'legacy',
            media,
            ranking_version: query.sort === 'recommended' ? 2 : 1,
            count: page.works.length,
            hasCursor: Boolean(cursor),
            hasSearch: Boolean(search),
            hasTag: tagIds.length > 0,
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
}
