import { generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DramaSummary } from '@miniapp/shared';
vi.mock('../../platform/config.js', () => ({ config: { database: { target: 'test' } } }));
import { getDramaStreamConfig } from '../../platform/runtime-config.js';
import {
  pinStreamDramas,
  selectStreamDelivery,
  signStreamPlayback,
  streamExperimentUser,
  streamManifestWarmupTargets,
} from './stream.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const videos = Array.from({ length: 30 }, () => ({
  dramaId: randomUUID(),
  videoId: randomUUID(),
  uid: randomBytes(16).toString('hex'),
}));
beforeEach(() => {
  vi.stubEnv('DRAMA_STREAM_SAMPLING_COHORT', '');
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'true');
  vi.stubEnv('DRAMA_STREAM_ENROLLMENT_BPS', '10000');
  vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
  vi.stubEnv('DRAMA_STREAM_MANIFEST', JSON.stringify({ environment: 'test', videos }));
  vi.stubEnv('DRAMA_STREAM_EXPERIMENT_ID', 'stream-unit');
  vi.stubEnv('DRAMA_STREAM_EXPERIMENT_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('DRAMA_STREAM_HOST', 'customer-unit.cloudflarestream.com');
  vi.stubEnv('DRAMA_STREAM_KEY_ID', 'unit-key');
  vi.stubEnv(
    'DRAMA_STREAM_PRIVATE_KEY',
    key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  );
});
afterEach(() => vi.unstubAllEnvs());
it('rejects partial, wrong-environment, duplicate and overlapping manifests', () => {
  expect(getDramaStreamConfig()).not.toBeNull();
  for (const manifest of [
    { environment: 'production', videos },
    { environment: 'test', videos: videos.slice(1) },
    { environment: 'test', videos: Array(30).fill(videos[0]!) },
  ]) {
    vi.stubEnv('DRAMA_STREAM_MANIFEST', JSON.stringify(manifest));
    expect(getDramaStreamConfig()).toBeNull();
  }
  vi.stubEnv('DRAMA_STREAM_MANIFEST', JSON.stringify({ environment: 'test', videos }));
  vi.stubEnv('DRAMA_CDN_ENABLED', 'true');
  expect(getDramaStreamConfig()).toBeNull();
});
it('pins the same 30 in order without dropping or duplicating the tail', () => {
  const items: DramaSummary[] = [...videos].reverse().map((v) => ({
    id: v.dramaId,
    title: '',
    tags: [],
    cover_url: null,
    description: '',
    episode_count: 1,
    duration_seconds: null,
  }));
  const tail = { ...items[0]!, id: randomUUID() };
  const ranked = pinStreamDramas([tail, ...items]);
  expect(ranked.map((v) => v.id)).toEqual([...videos.map((v) => v.dramaId), tail.id]);
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'false');
  expect(pinStreamDramas([tail, ...items])).toEqual([tail, ...items]);
});
it('creates a verifiable, expiring token for exactly one UID', () => {
  const result = signStreamPlayback(getDramaStreamConfig()!, videos[0]!.uid);
  const token = new URL(result.play_url).pathname.split('/')[1]!;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('invalid signed token');
  expect(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      key.publicKey,
      Buffer.from(signature, 'base64url')
    )
  ).toBe(true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  expect(claims.sub).toBe(videos[0]!.uid);
  expect(claims.exp * 1000).toBeGreaterThan(Date.now());
});

it('selects the manifest episodes irrespective of retired enrollment or cohort settings', () => {
  vi.stubEnv('DRAMA_STREAM_ENROLLMENT_BPS', '0');
  vi.stubEnv(
    'DRAMA_STREAM_SAMPLING_COHORT',
    JSON.stringify({
      experimentId: 'stream-unit',
      supabase: 1,
      stream: 2,
    })
  );
  for (const video of videos) {
    expect(selectStreamDelivery(video.dramaId, video.videoId)?.delivery).toMatchObject({
      group: 'stream',
      provider: 'stream',
    });
  }
  const first = videos[0]!;
  expect(selectStreamDelivery(first.dramaId, videos[1]!.videoId)).toBeNull();
  expect(selectStreamDelivery(randomUUID(), randomUUID())).toBeNull();
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'false');
  expect(selectStreamDelivery(first.dramaId, first.videoId)).toBeNull();
  const retained = selectStreamDelivery(first.dramaId, first.videoId, true)!;
  expect(streamExperimentUser(1, retained.config).experiment_user).toMatch(/^[a-f0-9]{64}$/);
});

it('keeps a listed video on Stream when its signing credentials are missing', () => {
  vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', '');
  const video = videos[29]!;
  const stream = selectStreamDelivery(video.dramaId, video.videoId)!;
  expect(stream.delivery.provider).toBe('stream');
  expect(() => signStreamPlayback(stream.config, video.uid)).toThrow();
});

it('signs one warmup target per listed UID, and none when Stream is off or unsigned', () => {
  const targets = streamManifestWarmupTargets();
  expect(targets.map((t) => t.uid)).toEqual(videos.map((v) => v.uid));
  expect(targets[0]!.playUrl).toMatch(
    /^https:\/\/customer-unit\.cloudflarestream\.com\/.+\/manifest\/video\.m3u8$/
  );
  vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', 'not-a-key');
  expect(streamManifestWarmupTargets()).toEqual([]);
  vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', '');
  expect(streamManifestWarmupTargets()).toEqual([]);
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'false');
  expect(streamManifestWarmupTargets()).toEqual([]);
});
