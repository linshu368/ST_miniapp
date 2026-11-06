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
it('assigns deterministically with both arms and only matches the selected episode', () => {
  const config = getDramaStreamConfig()!;
  const groups = new Set(
    Array.from({ length: 100 }, (_, n) => streamExperimentUser(n, config).assigned_group)
  );
  expect(groups.size).toBe(2);
  expect(streamExperimentUser(42, config)).toEqual(streamExperimentUser(42, config));
  expect(selectStreamDelivery(42, videos[0]!.dramaId, videos[1]!.videoId)).toBeNull();
  expect(selectStreamDelivery(42, videos[0]!.dramaId, videos[0]!.videoId)).not.toBeNull();
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

it('keeps assignments across enrollment expansion and retains telemetry identity on shutdown', () => {
  const full = selectStreamDelivery(42, videos[0]!.dramaId, videos[0]!.videoId)!;
  vi.stubEnv('DRAMA_STREAM_ENROLLMENT_BPS', '0');
  expect(selectStreamDelivery(42, videos[0]!.dramaId, videos[0]!.videoId)).toBeNull();
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'false');
  const historical = selectStreamDelivery(42, videos[0]!.dramaId, videos[0]!.videoId, true)!;
  expect(historical.delivery.group).toBe(full.delivery.group);
});

it('targets only two sampling accounts without changing other users or eligibility', () => {
  const config = getDramaStreamConfig()!;
  const original = Array.from({ length: 100 }, (_, id) => streamExperimentUser(id + 1, config));
  vi.stubEnv(
    'DRAMA_STREAM_SAMPLING_COHORT',
    JSON.stringify({ experimentId: config.id, supabase: 1, stream: 2 })
  );
  expect(streamExperimentUser(1, config).assigned_group).toBe('supabase');
  expect(streamExperimentUser(2, config).assigned_group).toBe('stream');
  for (let id = 3; id <= 100; id++) {
    expect(streamExperimentUser(id, config)).toEqual(original[id - 1]);
  }
  expect(streamExperimentUser(1, config).experiment_user).toBe(original[0]!.experiment_user);
  expect(selectStreamDelivery(2, videos[0]!.dramaId, videos[1]!.videoId)).toBeNull();
  vi.stubEnv('DRAMA_STREAM_ENROLLMENT_BPS', '0');
  expect(selectStreamDelivery(2, videos[0]!.dramaId, videos[0]!.videoId)).toBeNull();
  vi.stubEnv('DRAMA_STREAM_ENROLLMENT_BPS', '10000');
  vi.stubEnv('DRAMA_CDN_ENABLED', 'true');
  expect(selectStreamDelivery(2, videos[0]!.dramaId, videos[0]!.videoId)).toBeNull();
  vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'false');
  expect(selectStreamDelivery(2, videos[0]!.dramaId, videos[0]!.videoId)).toBeNull();
  expect(
    selectStreamDelivery(2, videos[0]!.dramaId, videos[0]!.videoId, true)?.delivery.group
  ).toBe('stream');
});

it('ignores malformed, stale, duplicate or unsafe sampling account settings', () => {
  const config = getDramaStreamConfig()!;
  const baseline = streamExperimentUser(1, config);
  for (const value of [
    'invalid json',
    JSON.stringify({ experimentId: 'old-experiment', supabase: 1, stream: 2 }),
    JSON.stringify({ experimentId: config.id, supabase: 1, stream: 1 }),
    JSON.stringify({ experimentId: config.id, supabase: -1, stream: 2 }),
    JSON.stringify({ experimentId: config.id, supabase: '1', stream: 2 }),
    JSON.stringify({ experimentId: config.id, supabase: 1, stream: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ experimentId: config.id, supabase: 1, stream: 2, extra: true }),
    ' '.repeat(513),
  ]) {
    vi.stubEnv('DRAMA_STREAM_SAMPLING_COHORT', value);
    expect(getDramaStreamConfig()).not.toBeNull();
    expect(streamExperimentUser(1, config)).toEqual(baseline);
  }
});
