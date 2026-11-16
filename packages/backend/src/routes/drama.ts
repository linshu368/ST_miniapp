// 短剧浏览与播放路由。只做鉴权、参数校验、调用编排和 HTTP 映射。
//
// 列表和详情一次签名都不做；播放地址走单独的 /play，点击卡片时只为选中的那一条视频
// 签一个 URL。前端可以并行请求详情和 /play，不必等详情回来再去拿播放地址。

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requestLogger } from '../lib/logger.js';
import { pinStreamDramas, streamManifestWarmupTargets } from '../features/drama/stream.js';
import { DramaPlaybackOptionsSchema, DramaPlayRequestSchema, ok, fail } from '@miniapp/shared';
import type { GetDramaByIdData, GetDramasData } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { DramaRepository } from '../features/drama/repository.js';
import { toDramaDetail, toDramaSummary } from '../features/drama/assemble.js';
import { DramaSignedUrlCache } from '../features/drama/signed-url.js';
import { DramaStreamManifestCache } from '../features/drama/stream-manifest-cache.js';
import { buildCoverUrl } from '../features/drama/cover-url.js';
import {
  createDramaPlayHandler,
  UUID_PATTERN,
  type DramaRequestTiming,
  type DramaStage,
} from './drama-play.js';
import { observeDramaRequest } from '../lib/engineering-observability.js';

export default async function dramaRoutes(app: FastifyInstance) {
  const repo = new DramaRepository();
  // 进程内缓存，整个 app 共用一份
  const signedUrls = new DramaSignedUrlCache();
  const streamManifests = new DramaStreamManifestCache();
  app.addHook('onReady', async () => {
    // 不等预热完成：启动和健康检查不受 Stream 源站影响。
    void streamManifests
      .prewarm(streamManifestWarmupTargets(), app.log)
      .then((result) => {
        if (result.cached + result.failed > 0)
          app.log.info(result, 'drama inline manifest prewarm done');
      })
      .catch(() => undefined);
  });
  const timings = new WeakMap<FastifyRequest, DramaRequestTiming>();
  app.addHook('onRequest', async (request) => {
    timings.set(request, { stages: {}, sign: {}, manifest: {} });
  });
  const measure = async <T>(
    request: FastifyRequest,
    stage: DramaStage,
    run: () => T | Promise<T>
  ): Promise<T> => {
    const startedAt = performance.now();
    const timing = timings.get(request)!;
    timing.activeStage = { stage, startedAt };
    try {
      return await run();
    } catch (err) {
      timing.errorStage = stage;
      throw err;
    } finally {
      timing.stages[stage] = performance.now() - startedAt;
      timing.activeStage = undefined;
    }
  };
  const authenticate = (request: FastifyRequest, reply: FastifyReply) =>
    measure(request, 'auth', () => requireTelegramAuth(request, reply));
  app.addHook('onResponse', async (request, reply) => {
    // onResponse 覆盖鉴权拒绝、无视频、查询错误与签名失败；不只记录成功路径。
    const timing = timings.get(request);
    if (!timing) return;
    // 鉴权可能直接 send(reply)；onResponse 会先于 preHandler 的 finally 执行。
    if (timing.activeStage) {
      timing.stages[timing.activeStage.stage] = performance.now() - timing.activeStage.startedAt;
    }
    const outcome =
      reply.statusCode >= 400 ? 'http_error' : timing.playable === false ? 'unplayable' : 'ok';
    const attributes = {
      route: request.routeOptions.url ?? 'unmatched',
      outcome,
      sign_cache: timing.sign.cache ?? 'unused',
      manifest_cache: timing.manifest.cache ?? 'unused',
    };
    observeDramaRequest({
      route: attributes.route,
      outcome,
      signCache: attributes.sign_cache,
      manifestCache: attributes.manifest_cache,
      stages: timing.stages,
      durationMs: reply.elapsedTime,
    });
    try {
      requestLogger(request.log, 'drama').biz.info(
        {
          event: 'drama.request_timing',
          source: 'backend',
          request_id: request.id,
          ...attributes,
          status: reply.statusCode,
          total_ms: reply.elapsedTime,
          auth_ms: timing.stages.auth,
          db_read_ms: timing.stages.db_read,
          assemble_ms: timing.stages.assemble,
          sign_ms: timing.stages.sign,
          manifest_ms: timing.stages.manifest,
          error_stage: timing.errorStage,
          delivery: timing.delivery,
        },
        'drama request timing'
      );
    } catch {
      /* 监控故障不能改变响应。 */
    }
  });

  // @frontend-ready: true — MVP：封面/时长待归档端补数据，标题/标签/播放已可用
  app.get('/api/dramas', { preHandler: [authenticate] }, async (request, reply) => {
    const dramas = await measure(request, 'db_read', () => repo.listDramas());
    const shuffled = await measure(request, 'assemble', () => {
      // 归档流水线是异步的：剧的元数据可能先落库，视频还没传完，这期间不应该出现在列表里。
      // 推荐保留现有随机顺序；前端“最新”按 first_published_at 独立排序。
      const shuffled = dramas
        .map((drama) => toDramaSummary(drama, buildCoverUrl))
        .filter((drama) => drama.episode_count > 0);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      return pinStreamDramas(shuffled);
    });
    return reply.send(ok<GetDramasData>({ dramas: shuffled }));
  });

  // @frontend-ready: true — MVP：封面/时长待归档端补数据，标题/标签/播放已可用
  app.get('/api/dramas/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send(fail('BAD_REQUEST', '短剧 ID 无效'));
    }

    const drama = await measure(request, 'db_read', () => repo.getDrama(id));
    if (!drama) return reply.status(404).send(fail('NOT_FOUND', '短剧不存在'));

    const detail = await measure(request, 'assemble', () => toDramaDetail(drama, buildCoverUrl));
    return reply.send(ok<GetDramaByIdData>({ drama: detail }));
  });

  const handlePlay = createDramaPlayHandler({
    repo,
    signedUrls,
    streamManifests,
    timings,
    measure,
  });

  // @frontend-ready: true — 旧客户端使用；新客户端走固定地址的 POST /api/dramas/play
  app.get('/api/dramas/:id/play', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DramaPlaybackOptionsSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send(fail('BAD_REQUEST', '播放参数无效'));
    return handlePlay(request, reply, { dramaId: id, options: parsed.data });
  });

  // @frontend-ready: true — 固定地址使 CORS 预检可缓存；请求体见 DramaPlayRequestSchema
  app.post('/api/dramas/play', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = DramaPlayRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(fail('BAD_REQUEST', '播放参数无效'));
    const { drama_id: dramaId, ...options } = parsed.data;
    return handlePlay(request, reply, { dramaId, options });
  });
}
