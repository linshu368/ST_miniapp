import { createHmac } from 'node:crypto';
import { DRAMA_CDN_SAMPLE_ID, type DramaCdnRoute, type DramaPlayback } from '@miniapp/shared';

export const BUNNY_HOST = 'stminiappvid20261028.b-cdn.net';
export const BUNNY_PATH = '/experiment/v1.mp4';
const SOURCE_PATH = `/storage/v1/object/sign/drama-videos/videos/${DRAMA_CDN_SAMPLE_ID}/original`;

export interface DramaCdnConfig {
  enabled: boolean;
  userIds: readonly number[];
  sourceUrl: string;
  tokenKey: string;
  deadlineMs: number;
}

/** Validate the single operator-supplied capability; never put a production key in Preview. */
export function sourceExpiry(sourceUrl: string): number {
  try {
    const url = new URL(sourceUrl);
    if (
      url.origin !== 'https://wbtsfzozlmurljvglhpn.supabase.co' ||
      url.pathname !== SOURCE_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== 'token')
    )
      return 0;
    const payload: unknown = JSON.parse(
      Buffer.from(url.searchParams.get('token')?.split('.')[1] ?? '', 'base64url').toString()
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      !('url' in payload) ||
      payload.url !== `drama-videos/videos/${DRAMA_CDN_SAMPLE_ID}/original`
    )
      return 0;
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

/** Both paths retain a complete URL. No media fetch, signing service, or origin retry here. */
export class DramaCdnExperiment {
  private cached?: { key: string; url: string; expiresMs: number };

  playback(config: DramaCdnConfig, route: DramaCdnRoute, now = Date.now()): DramaPlayback | null {
    const originExpiry = sourceExpiry(config.sourceUrl);
    if (originExpiry - now <= 60_000) return null;
    if (route === 'original')
      return {
        video_id: DRAMA_CDN_SAMPLE_ID,
        playable: true,
        play_url: config.sourceUrl,
        expires_at: new Date(originExpiry).toISOString(),
      };
    const expiresMs =
      Math.floor(Math.min(now + 1_800_000, originExpiry - 60_000, config.deadlineMs) / 1000) * 1000;
    if (!config.tokenKey || expiresMs - now <= 60_000) return null;
    const key = `${config.sourceUrl}:${config.tokenKey}:${config.deadlineMs}`;
    if (!this.cached || this.cached.key !== key || this.cached.expiresMs - now <= 60_000) {
      const expires = String(expiresMs / 1000);
      const token = createHmac('sha256', config.tokenKey)
        .update(BUNNY_PATH + expires)
        .digest('base64url');
      this.cached = {
        key,
        expiresMs,
        url: `https://${BUNNY_HOST}${BUNNY_PATH}?token=HS256-${token}&expires=${expires}`,
      };
    }
    return {
      video_id: DRAMA_CDN_SAMPLE_ID,
      playable: true,
      play_url: this.cached.url,
      expires_at: new Date(this.cached.expiresMs).toISOString(),
    };
  }
}
