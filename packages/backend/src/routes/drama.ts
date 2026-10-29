// 短剧浏览与播放路由。只做鉴权、参数校验、调用编排和 HTTP 映射。
//
// 列表和详情一次签名都不做；播放地址走单独的 /play，点击卡片时只为选中的那一条视频
// 签一个 URL。前端可以并行请求详情和 /play，不必等详情回来再去拿播放地址。

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requestLogger } from '../lib/logger.js';
import { ok, fail } from '@miniapp/shared';
import type { GetDramaByIdData, GetDramaPlaybackData, GetDramasData } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { DramaRepository } from '../features/drama/repository.js';
import { isPlayable, toDramaDetail, toDramaSummary } from '../features/drama/assemble.js';
import { DramaSignedUrlCache, type DramaSigningObservation } from '../features/drama/signed-url.js';
import { buildCoverUrl } from '../features/drama/cover-url.js';
import { observeDramaRequest } from '../lib/engineering-observability.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function dramaRoutes(app: FastifyInstance) {
  const repo = new DramaRepository();
  // 进程内缓存，整个 app 共用一份
  const signedUrls = new DramaSignedUrlCache();
  type Stage = 'auth' | 'db_read' | 'assemble' | 'sign';
  type RequestTiming = {
    stages: Partial<Record<Stage, number>>;
    sign: DramaSigningObservation;
    errorStage?: Stage;
    playable?: boolean;
    activeStage?: { stage: Stage; startedAt: number };
  };
  const timings = new WeakMap<FastifyRequest, RequestTiming>();
  app.addHook('onRequest', async (request) => {
    timings.set(request, { stages: {}, sign: {} });
  });
  const measure = async <T>(
    request: FastifyRequest,
    stage: Stage,
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
    };
    observeDramaRequest({
      route: attributes.route,
      outcome,
      signCache: attributes.sign_cache,
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
          error_stage: timing.errorStage,
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
      return shuffled;
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

  // @frontend-ready: true — MVP：封面/时长待归档端补数据，标题/标签/播放已可用
  app.get('/api/dramas/:id/play', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { video_id: videoId } = request.query as { video_id?: string };

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send(fail('BAD_REQUEST', '短剧 ID 无效'));
    }
    if (videoId !== undefined && !UUID_PATTERN.test(videoId)) {
      return reply.status(400).send(fail('BAD_REQUEST', '视频 ID 无效'));
    }

    const drama = await measure(request, 'db_read', () => repo.getDramaForPlayback(id));
    if (!drama) return reply.status(404).send(fail('NOT_FOUND', '短剧不存在'));

    // 指定了就必须属于这部剧；不属于和不存在一律 404，不泄露该视频是否存在
    const selected = await measure(request, 'assemble', () =>
      videoId ? drama.videos.find((v) => v.id === videoId) : drama.videos.find(isPlayable)
    );
    if (videoId && !selected) {
      return reply.status(404).send(fail('NOT_FOUND', '视频不存在'));
    }

    // 签名 URL 是临时凭证，禁止中间代理存储；不影响 backend 内部内存缓存
    reply.header('Cache-Control', 'private, no-store');

    // 未就绪的不签名，直接回不可播，让前端显示「暂无可用集数」
    if (!selected || !isPlayable(selected)) {
      timings.get(request)!.playable = false;
      return reply.send(
        ok<GetDramaPlaybackData>({
          playback: {
            video_id: selected?.id ?? null,
            playable: false,
            play_url: null,
            expires_at: null,
          },
        })
      );
    }

    const timing = timings.get(request)!;
    const signed = await measure(request, 'sign', () =>
      signedUrls.getPlayUrl(selected.object_path!, request.log, timing.sign)
    );
    timing.playable = signed.playable;
    if (!signed.playable) timing.errorStage = 'sign';

    return reply.send(ok<GetDramaPlaybackData>({ playback: { video_id: selected.id, ...signed } }));
  });
}
