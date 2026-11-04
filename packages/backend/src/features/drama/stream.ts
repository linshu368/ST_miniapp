import { createHmac, createPrivateKey, sign } from 'node:crypto';
import type { DramaDelivery, DramaSummary } from '@miniapp/shared';
import { getDramaStreamConfig } from '../../platform/runtime-config.js';

type StreamConfig = NonNullable<ReturnType<typeof getDramaStreamConfig>>;

export function streamExperimentUser(userId: number, config: StreamConfig) {
  const input = `${config.environment}:${config.id}:${userId}`;
  const bucket =
    createHmac('sha256', config.key).update(`bucket:${input}`).digest().readUInt32BE(0) % 10000;
  return {
    experiment_id: config.id,
    assigned_group: bucket < 5000 ? ('stream' as const) : ('supabase' as const),
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

export function selectStreamDelivery(
  userId: number,
  dramaId: string,
  videoId: string,
  retainIdentity = false
) {
  const config = getDramaStreamConfig(retainIdentity);
  const video = config?.videos.find((v) => v.dramaId === dramaId && v.videoId === videoId);
  if (!config || !video) return null;
  const enrollment =
    createHmac('sha256', config.key)
      .update(`enrollment:${config.environment}:${config.id}:${userId}`)
      .digest()
      .readUInt32BE(0) % 10000;
  if (!retainIdentity && enrollment >= config.enrollmentBps) return null;
  const identity = streamExperimentUser(userId, config);
  const delivery: DramaDelivery = {
    experimentId: config.id,
    group: identity.assigned_group,
    provider: identity.assigned_group,
    reason: 'assigned',
  };
  return { config, video, delivery };
}

/** Sign locally: no Stream management request participates in the first-frame path. */
export function signStreamPlayback(config: StreamConfig, uid: string) {
  const expires = Math.floor(Date.now() / 1000) + 900;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: config.keyId })).toString(
    'base64url'
  );
  const payload = Buffer.from(
    JSON.stringify({ sub: uid, kid: config.keyId, exp: expires })
  ).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(input),
    createPrivateKey(
      config.privateKey.includes('-----BEGIN')
        ? config.privateKey.replace(/\\n/g, '\n')
        : Buffer.from(config.privateKey, 'base64')
    )
  ).toString('base64url');
  return {
    playable: true,
    play_url: `https://${config.host}/${input}.${signature}/manifest/video.m3u8`,
    expires_at: new Date(expires * 1000).toISOString(),
    format: 'hls' as const,
  };
}
