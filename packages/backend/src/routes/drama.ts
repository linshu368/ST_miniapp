// 短剧浏览与播放路由。只做鉴权、参数校验、调用编排和 HTTP 映射。
//
// 列表和详情一次签名都不做；播放地址走单独的 /play，点击卡片时只为选中的那一条视频
// 签一个 URL。前端可以并行请求详情和 /play，不必等详情回来再去拿播放地址。

import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type { GetDramaByIdData, GetDramaPlaybackData, GetDramasData } from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { DramaRepository } from '../features/drama/repository.js';
import { isPlayable, toDramaDetail, toDramaSummary } from '../features/drama/assemble.js';
import { DramaSignedUrlCache } from '../features/drama/signed-url.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function dramaRoutes(app: FastifyInstance) {
  const repo = new DramaRepository();
  // 进程内缓存，整个 app 共用一份
  const signedUrls = new DramaSignedUrlCache();

  // @frontend-ready: true — MVP：封面/时长待归档端补数据，标题/标签/播放已可用
  app.get('/api/dramas', { preHandler: [requireTelegramAuth] }, async (_request, reply) => {
    const dramas = await repo.listDramas();
    // 先随机展示；dramas.created_at 落库后改为按时间倒序
    const shuffled = dramas.map(toDramaSummary);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return reply.send(ok<GetDramasData>({ dramas: shuffled }));
  });

  // @frontend-ready: true — MVP：封面/时长待归档端补数据，标题/标签/播放已可用
  app.get('/api/dramas/:id', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send(fail('BAD_REQUEST', '短剧 ID 无效'));
    }

    const drama = await repo.getDrama(id);
    if (!drama) return reply.status(404).send(fail('NOT_FOUND', '短剧不存在'));

    return reply.send(ok<GetDramaByIdData>({ drama: toDramaDetail(drama) }));
  });

  // @frontend-ready: true — MVP：封面/时长待归档端补数据，标题/标签/播放已可用
  app.get('/api/dramas/:id/play', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    const startedAt = Date.now();
    const { id } = request.params as { id: string };
    const { video_id: videoId } = request.query as { video_id?: string };

    if (!UUID_PATTERN.test(id)) {
      return reply.status(400).send(fail('BAD_REQUEST', '短剧 ID 无效'));
    }
    if (videoId !== undefined && !UUID_PATTERN.test(videoId)) {
      return reply.status(400).send(fail('BAD_REQUEST', '视频 ID 无效'));
    }

    const drama = await repo.getDramaForPlayback(id);
    if (!drama) return reply.status(404).send(fail('NOT_FOUND', '短剧不存在'));

    // 指定了就必须属于这部剧；不属于和不存在一律 404，不泄露该视频是否存在
    const selected = videoId
      ? drama.videos.find((v) => v.id === videoId)
      : drama.videos.find(isPlayable);
    if (videoId && !selected) {
      return reply.status(404).send(fail('NOT_FOUND', '视频不存在'));
    }

    // 签名 URL 是临时凭证，禁止中间代理存储；不影响 backend 内部内存缓存
    reply.header('Cache-Control', 'private, no-store');

    // 未就绪的不签名，直接回不可播，让前端显示「暂无可用集数」
    if (!selected || !isPlayable(selected)) {
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

    const signed = await signedUrls.getPlayUrl(selected.object_path!, request.log);
    request.log.info(
      { drama_id: id, duration_ms: Date.now() - startedAt, playable: signed.playable },
      'drama playback resolved'
    );

    return reply.send(ok<GetDramaPlaybackData>({ playback: { video_id: selected.id, ...signed } }));
  });
}
