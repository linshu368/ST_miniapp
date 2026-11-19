import { getDramaStreamSigningConfig } from '../../platform/runtime-config.js';
import type { GetVideoPlazaDownloadData, VideoPlazaPlayback } from '@miniapp/shared';
import { z } from 'zod';
import { signStreamToken } from '../../lib/stream-signing.js';
import { clientFetch } from '../../platform/observability/fetch.js';
import { DramaStreamManifestCache } from '../drama/stream-manifest-cache.js';
import {
  getStreamVideo,
  readStreamBody,
  streamRequest,
  VideoStreamError,
} from './video-stream-client.js';

const manifests = new DramaStreamManifestCache(readPlaylist);
function requirePlazaSigning() {
  const signing = getDramaStreamSigningConfig();
  if (!signing) throw new VideoStreamError('video_stream_provider_unavailable');
  return signing;
}

function signPlayback(uid: string): VideoPlazaPlayback {
  const config = requirePlazaSigning();
  const signed = signStreamToken(config, uid);
  return {
    format: 'hls',
    play_url: `https://${config.host}/${signed.token}/manifest/video.m3u8`,
    expires_at: signed.expires_at,
  };
}
export async function signPlazaStreamPlayback(uid: string): Promise<VideoPlazaPlayback> {
  const playback = signPlayback(uid);
  const inline_manifest = await manifests.getManifest(uid, playback.play_url);
  return { ...playback, ...(inline_manifest ? { inline_manifest } : {}) };
}

export function stablePlazaPlaybackUrl(uid: string): string {
  const config = requirePlazaSigning();
  return `https://${config.host}/${uid}/manifest/video.m3u8`;
}

async function readPlaylist(url: string, signal?: AbortSignal): Promise<string> {
  const response = await clientFetch('video.delivery.manifest', 'cloudflare')(url, {
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new VideoStreamError('video_stream_manifest_unavailable', true);
  }
  const text = (await readStreamBody(response, 64 * 1024)).toString();
  if (!text.startsWith('#EXTM3U'))
    throw new VideoStreamError('video_stream_manifest_invalid', true);
  return text;
}

/** Never follow manifest-controlled URLs outside the signed customer origin. */
function sameOriginUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin || url.username || url.password)
    throw new VideoStreamError('video_stream_manifest_origin_invalid');
  return url.href;
}

export async function verifyStreamReady(uid: string, signal?: AbortSignal) {
  const video = await getStreamVideo(uid, signal);
  if (!video.requireSignedURLs) throw new VideoStreamError('video_stream_privacy_invalid');
  if (video.status.state === 'error') throw new VideoStreamError('video_stream_encode_failed');
  if (
    !video.readyToStream ||
    video.status.state !== 'ready' ||
    !video.input ||
    video.input.width < 1 ||
    video.input.height < 1 ||
    !video.duration ||
    video.duration <= 0
  )
    return null;
  const playback = signPlayback(uid);
  const manifest = await readPlaylist(playback.play_url, signal);
  const lines = manifest.split(/\r?\n/);
  const variants = lines.flatMap((line, i) => {
    const match = /^#EXT-X-STREAM-INF:.*\bBANDWIDTH=(\d+)/.exec(line);
    return match && lines[i + 1] && !lines[i + 1]!.startsWith('#')
      ? [{ bandwidth: Number(match[1]), url: sameOriginUrl(lines[i + 1]!, playback.play_url) }]
      : [];
  });
  const required = Math.min(video.input.width, video.input.height) >= 480 ? 2 : 1;
  if (new Set(variants.map((v) => v.bandwidth)).size < required) return null;
  // Verify each rendition, not just an advertised BANDWIDTH entry.
  for (const variant of variants.slice(0, 8)) {
    const playlist = await readPlaylist(variant.url, signal);
    const segment = playlist.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
    if (!segment) return null;
    const response = await clientFetch('video.delivery.segment', 'cloudflare')(
      sameOriginUrl(segment, variant.url),
      {
        headers: { Range: 'bytes=0-1023' },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    await response.body?.cancel();
  }
  const anonymous = await clientFetch('video.delivery.privacy', 'cloudflare')(
    stablePlazaPlaybackUrl(uid),
    {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    }
  );
  await anonymous.body?.cancel();
  if (![401, 403, 404].includes(anonymous.status))
    throw new VideoStreamError('video_stream_anonymous_access_invalid', anonymous.status >= 500);
  return {
    width: video.input.width,
    height: video.input.height,
    durationMs: Math.round(video.duration * 1000),
    renditionCount: variants.length,
  };
}

export async function streamPoster(uid: string, signal?: AbortSignal): Promise<Buffer> {
  const config = requirePlazaSigning();
  const signed = signStreamToken(config, uid);
  const response = await clientFetch('video.delivery.poster', 'cloudflare')(
    `https://${config.host}/${signed.token}/thumbnails/thumbnail.jpg?time=0s&width=720`,
    {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new VideoStreamError('video_stream_poster_failed', true);
  }
  return readStreamBody(response, 20 * 1024 * 1024);
}

export async function getStreamDownload(uid: string): Promise<GetVideoPlazaDownloadData> {
  const schema = z.object({
    default: z.object({
      status: z.enum(['inprogress', 'ready', 'error']),
      url: z.string().optional(),
    }),
  });
  // Cloudflare's derivative creation is idempotent; an existing ready derivative is retained.
  const result = schema.parse(await streamRequest(`/${uid}/downloads`, { method: 'POST' }));
  if (result.default.status === 'error')
    return { status: 'failed', error_code: 'video_stream_download_failed' };
  if (result.default.status !== 'ready') return { status: 'processing', retry_after_ms: 5000 };
  const config = requirePlazaSigning();
  const signed = signStreamToken(config, uid, true);
  return {
    status: 'ready',
    download_url: `https://${config.host}/${signed.token}/downloads/default.mp4`,
    expires_at: signed.expires_at,
  };
}
