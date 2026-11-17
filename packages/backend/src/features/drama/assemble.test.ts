import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../platform/config.js', () => ({ config: { database: { target: 'test' } } }));
import { isPlayable, playableVideos, toDramaDetail, toDramaSummary } from './assemble.js';
import type { DramaRow, VideoRow } from './repository.js';

const legacy = (id: string): VideoRow => ({
  id,
  episode: null,
  object_path: `videos/${id}/original`,
  storage_provider: 'supabase',
  stream_uid: null,
  stream_ready_at: null,
  upload_succeeded: true,
  cover_path: null,
  cover_upload_succeeded: false,
  original_title: null,
  original_tags: [],
  original_description: null,
  created_at: '2026-10-21T00:00:00Z',
});
const stream = (id: string, over: Partial<VideoRow> = {}): VideoRow => ({
  ...legacy(id),
  object_path: null,
  storage_provider: 'cloudflare_stream',
  stream_uid: 'ab'.repeat(16),
  stream_ready_at: '2026-11-10T00:00:00Z',
  ...over,
});
const drama = (videos: VideoRow[]): DramaRow => ({
  id: 'd',
  title: 't',
  tags: [],
  description: null,
  ai_title: null,
  ai_tags: [],
  ai_description: null,
  videos,
});
const cover = () => 'cover';

beforeEach(() => {
  vi.stubEnv('DRAMA_STREAM_HOST', 'customer-unit.cloudflarestream.com');
  vi.stubEnv('DRAMA_STREAM_KEY_ID', 'unit-key');
  vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', 'private-key');
});
afterEach(() => vi.unstubAllEnvs());

it('stage one: legacy Supabase videos and ready Stream videos both play', () => {
  expect(isPlayable(legacy('a'))).toBe(true);
  expect(isPlayable(stream('b'))).toBe(true);
  expect(toDramaSummary(drama([legacy('a'), stream('b')]), cover).episode_count).toBe(2);
});

it('a Stream row needs its uid, readiness stamp, upload task and signing configuration', () => {
  expect(isPlayable(stream('a', { stream_uid: null }))).toBe(false);
  expect(isPlayable(stream('a', { stream_ready_at: null }))).toBe(false);
  expect(isPlayable(stream('a', { upload_succeeded: false }))).toBe(false);
  // object_path is irrelevant to a Stream row
  expect(isPlayable(stream('a', { object_path: 'videos/a/original' }))).toBe(true);
  vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', '');
  expect(isPlayable(stream('a'))).toBe(false);
  expect(isPlayable(legacy('a'))).toBe(true);
});

it('stage two: legacy rows stop playing and only fully-Stream dramas are listed', () => {
  vi.stubEnv('DRAMA_LEGACY_SUPABASE_ENABLED', 'false');
  expect(isPlayable(legacy('a'))).toBe(false);
  expect(isPlayable(stream('b'))).toBe(true);
  const all = drama([stream('b'), stream('c')]);
  expect(playableVideos(all).map((v) => v.id)).toEqual(['b', 'c']);
  expect(toDramaSummary(all, cover).episode_count).toBe(2);
  expect(toDramaDetail(all, cover).videos).toHaveLength(2);
  for (const mixed of [
    drama([legacy('a'), stream('b')]),
    drama([stream('b'), stream('c', { stream_uid: null, stream_ready_at: null })]),
    drama([]),
  ]) {
    expect(playableVideos(mixed)).toEqual([]);
    expect(toDramaSummary(mixed, cover).episode_count).toBe(0);
    expect(toDramaDetail(mixed, cover).videos).toEqual([]);
  }
});

it('only the literal "false" ends stage one', () => {
  for (const value of ['', 'true', '0', 'no']) {
    vi.stubEnv('DRAMA_LEGACY_SUPABASE_ENABLED', value);
    expect(isPlayable(legacy('a'))).toBe(true);
  }
});
