// 短剧播放地址处理。GET /api/dramas/:id/play（旧客户端）与 POST /api/dramas/play 共用，
// 两者只负责把参数解析成 { dramaId, options }，签名、计时和视频选源都在这里。

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type { DramaDelivery, GetDramaPlaybackData } from '@miniapp/shared';
import { isPlayable } from '../features/drama/assemble.js';
import { selectDramaDelivery } from '../features/drama/delivery.js';
import type { DramaRepository } from '../features/drama/repository.js';
import type { DramaSignedUrlCache, DramaSigningObservation } from '../features/drama/signed-url.js';
import { selectStreamDelivery, signStreamPlayback } from '../features/drama/stream.js';
import type {
  DramaManifestObservation,
  DramaStreamManifestCache,
} from '../features/drama/stream-manifest-cache.js';

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DramaStage = 'auth' | 'db_read' | 'assemble' | 'sign' | 'manifest';

export type DramaRequestTiming = {
  stages: Partial<Record<DramaStage, number>>;
  sign: DramaSigningObservation;
  manifest: DramaManifestObservation;
  errorStage?: DramaStage;
  playable?: boolean;
  delivery?: DramaDelivery;
  activeStage?: { stage: DramaStage; startedAt: number };
};

export interface DramaPlayDeps {
  repo: DramaRepository;
  signedUrls: DramaSignedUrlCache;
  streamManifests: DramaStreamManifestCache;
  timings: WeakMap<FastifyRequest, DramaRequestTiming>;
  measure: <T>(request: FastifyRequest, stage: DramaStage, run: () => T | Promise<T>) => Promise<T>;
}

export interface DramaPlayInput {
  dramaId: string;
  options: { video_id?: string; format?: 'hls'; fallback?: 'mp4' };
}

async function sendStreamPlayback(
  stream: NonNullable<ReturnType<typeof selectStreamDelivery>>,
  request: FastifyRequest,
  reply: FastifyReply,
  streamManifests: DramaStreamManifestCache,
  timings: WeakMap<FastifyRequest, DramaRequestTiming>,
  measure: DramaPlayDeps['measure']
): Promise<void> {
  const timing = timings.get(request)!;
  timing.delivery = stream.delivery;
  try {
    const signed = await measure(request, 'sign', () =>
      signStreamPlayback(stream.config, stream.video.uid)
    );
    timing.playable = true;
    const inlineManifest = await measure(request, 'manifest', () =>
      streamManifests.getManifest(stream.video.uid, signed.play_url, request.log, timing.manifest)
    );
    await reply.send(
      ok<GetDramaPlaybackData>({
        playback: {
          video_id: stream.video.videoId,
          ...signed,
          ...(inlineManifest !== undefined ? { inline_manifest: inlineManifest } : {}),
          delivery: stream.delivery,
        },
      })
    );
  } catch {
    // No token or signing error text is safe to include in telemetry.
    timing.delivery = { ...stream.delivery, provider: 'unknown', reason: 'unavailable' };
    timing.playable = false;
    await reply.send(
      ok<GetDramaPlaybackData>({
        playback: {
          video_id: stream.video.videoId,
          playable: false,
          play_url: null,
          expires_at: null,
          delivery: timing.delivery,
        },
      })
    );
  }
}

export function createDramaPlayHandler({
  repo,
  signedUrls,
  streamManifests,
  timings,
  measure,
}: DramaPlayDeps) {
  return async (request: FastifyRequest, reply: FastifyReply, input: DramaPlayInput) => {
    const { dramaId: id, options } = input;
    const { video_id: videoId } = options;

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
      const { delivery } = selectDramaDelivery(request.user!.id);
      const unavailable = delivery
        ? { ...delivery, provider: 'unknown' as const, reason: 'unavailable' as const }
        : undefined;
      timings.get(request)!.delivery = unavailable;
      return reply.send(
        ok<GetDramaPlaybackData>({
          playback: {
            video_id: selected?.id ?? null,
            playable: false,
            play_url: null,
            expires_at: null,
            delivery: unavailable,
          },
        })
      );
    }

    // Both endpoints accept legacy format/fallback hints. The selected episode owns its source.
    const stream = selectStreamDelivery(id, selected.id);
    if (stream) {
      return sendStreamPlayback(stream, request, reply, streamManifests, timings, measure);
    }
    const selection = selectDramaDelivery(request.user!.id);
    const timing = timings.get(request)!;
    timing.delivery = selection.delivery;
    const signed = await measure(request, 'sign', () =>
      signedUrls.getPlayUrl(selected.object_path!, request.log, timing.sign, selection.cdn)
    );
    timing.playable = signed.playable;
    if (!signed.playable) timing.errorStage = 'sign';

    const delivery =
      selection.delivery && !signed.playable
        ? { ...selection.delivery, provider: 'unknown' as const, reason: 'unavailable' as const }
        : selection.delivery;
    timing.delivery = delivery;
    return reply.send(
      ok<GetDramaPlaybackData>({ playback: { video_id: selected.id, ...signed, delivery } })
    );
  };
}
