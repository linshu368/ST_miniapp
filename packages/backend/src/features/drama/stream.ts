import { createHmac, createPrivateKey, sign } from 'node:crypto';
import type { DramaDelivery, DramaSummary } from '@miniapp/shared';
import { getDramaStreamConfig } from '../../platform/runtime-config.js';

type StreamConfig = NonNullable<ReturnType<typeof getDramaStreamConfig>>;

export function streamExperimentUser(userId: number, config: StreamConfig) {
  const input = `${config.environment}:${config.id}:${userId}`;
  return {
    experiment_id: config.id,
    experiment_user: createHmac('sha256', config.key).update(`user:${input}`).digest('hex'),
  };
}

/** Read the same ordered manifest for both ranking and individual-video eligibility. */
export function pinStreamDramas(dramas: DramaSummary[]): DramaSummary[] {
  const config = getDramaStreamConfig();
  if (!config) return dramas;
  const ranks = new Map(config.videos.map((v, i) => [v.dramaId, i]));
  return [...dramas].sort((a, b) => (ranks.get(a.id) ?? 30) - (ranks.get(b.id) ?? 30));
}

export function selectStreamDelivery(dramaId: string, videoId: string, retainIdentity = false) {
  const config = getDramaStreamConfig(retainIdentity);
  const video = config?.videos.find((v) => v.dramaId === dramaId && v.videoId === videoId);
  if (!config || !video) return null;
  const delivery: DramaDelivery = {
    experimentId: config.id,
    group: 'stream',
    provider: 'stream',
    reason: 'assigned',
  };
  return { config, video, delivery };
}

/** Sign locally: no Stream management request participates in the first-frame path. */
export function signStreamPlayback(config: StreamConfig, uid: string) {
  if (!config.signing) throw new Error('drama_stream_signing_unavailable');
  const { host, keyId, privateKey } = config.signing;
  const expires = Math.floor(Date.now() / 1000) + 900;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: uid, kid: keyId, exp: expires })).toString(
    'base64url'
  );
  const input = `${header}.${payload}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(input),
    createPrivateKey(
      privateKey.includes('-----BEGIN')
        ? privateKey.replace(/\\n/g, '\n')
        : Buffer.from(privateKey, 'base64')
    )
  ).toString('base64url');
  return {
    playable: true,
    play_url: `https://${host}/${input}.${signature}/manifest/video.m3u8`,
    expires_at: new Date(expires * 1000).toISOString(),
    format: 'hls' as const,
  };
}
