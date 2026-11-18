import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerVideoPlazaPlaybackRoutes } from './video-plaza-playback.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ARTIFACT = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const WORK = '55555555-5555-4555-8555-555555555555';
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  reads: [] as string[],
  sign: vi.fn(),
  download: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('../lib/supabase.js', () => ({
  getDomainDb: () => ({
    from(table: string) {
      state.reads.push(table);
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        limit: () => builder,
        eq: (key: string, value: unknown) => {
          filters.push((row) => row[key] === value);
          return builder;
        },
        is: (key: string, value: unknown) => {
          filters.push((row) => row[key] === value);
          return builder;
        },
        maybeSingle: async () => ({
          data: state.rows[table]?.find((row) => filters.every((filter) => filter(row))) ?? null,
          error: null,
        }),
      };
      return builder;
    },
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireTelegramAuth: async () => undefined }));
vi.mock('./image-plaza-helpers.js', () => ({
  UUID_PATTERN: /^[a-f0-9-]{36}$/,
  userContext: async (
    request: { headers: Record<string, string> },
    reply: { code: (code: number) => { send: () => void } }
  ) => {
    const id = request.headers['x-test-user'];
    if (!id) {
      reply.code(401).send();
      return null;
    }
    return { id };
  },
}));
vi.mock('../features/image-plaza/storage.js', () => ({ signPrivateVideoPath: vi.fn() }));
vi.mock('../features/image-plaza/video-stream-playback.js', () => ({
  signPlazaStreamPlayback: state.sign,
  getStreamDownload: state.download,
}));
vi.mock('../platform/observability/runtime.js', () => ({
  observation: {
    observe: async (_name: string, run: () => Promise<unknown>) => run(),
    emit: state.emit,
  },
}));

const app = Fastify();
registerVideoPlazaPlaybackRoutes(app);
afterEach(() => vi.clearAllMocks());
beforeEach(() => {
  state.reads = [];
  state.rows = {
    video_artifacts: [
      { id: ARTIFACT, attempt_id: ATTEMPT, stream_uid: 'a'.repeat(32), poster_path: null },
    ],
    video_attempts: [{ id: ATTEMPT, user_id: OWNER, conversation_id: WORK, status: 'ready' }],
    image_plaza_works: [],
  };
  state.sign.mockResolvedValue({
    format: 'hls',
    play_url: 'https://customer-fixture.cloudflarestream.com/fixture/manifest/video.m3u8',
    expires_at: '2026-11-17T00:00:00Z',
  });
  state.download.mockResolvedValue({ status: 'processing', retry_after_ms: 5000 });
});

it('authenticates before reading assets and prevents another user from viewing or downloading a private video', async () => {
  expect(
    (await app.inject({ url: `/api/image-plaza/video-artifacts/${ARTIFACT}/playback` })).statusCode
  ).toBe(401);
  expect(state.reads).toHaveLength(0);
  for (const action of ['playback', 'download']) {
    const result = await app.inject({
      url: `/api/image-plaza/video-artifacts/${ARTIFACT}/${action}`,
      headers: { 'x-test-user': OTHER },
    });
    expect(result.statusCode).toBe(404);
  }
  expect(state.sign).not.toHaveBeenCalled();
  expect(state.download).not.toHaveBeenCalled();
});
it('returns private no-store HLS for the owner and keeps a preparing MP4 download separate', async () => {
  const playback = await app.inject({
    url: `/api/image-plaza/video-artifacts/${ARTIFACT}/playback`,
    headers: { 'x-test-user': OWNER },
  });
  expect(playback.statusCode).toBe(200);
  expect(playback.headers['cache-control']).toBe('private, no-store');
  expect(playback.json().data.playback.format).toBe('hls');
  expect(playback.json().data).not.toHaveProperty('video_url');
  const download = await app.inject({
    url: `/api/image-plaza/video-artifacts/${ARTIFACT}/download`,
    headers: { 'x-test-user': OWNER },
  });
  expect(download.json().data).toEqual({ status: 'processing', retry_after_ms: 5000 });
});
it('permits a published seed without an attempt, then rejects the same artifact after work deletion', async () => {
  state.rows.video_artifacts![0]!.attempt_id = null;
  state.rows.image_plaza_works = [{ id: WORK, video_artifact_id: ARTIFACT, deleted_at: null }];
  const options = {
    url: `/api/image-plaza/video-artifacts/${ARTIFACT}/playback`,
    headers: { 'x-test-user': OTHER },
  };
  expect((await app.inject(options)).statusCode).toBe(200);
  expect(state.reads).not.toContain('video_attempts');
  state.rows.image_plaza_works[0]!.deleted_at = '2026-11-17T00:00:00Z';
  expect((await app.inject(options)).statusCode).toBe(404);
});
it('validates observations strictly and enforces access again before emitting a safe event', async () => {
  const body = {
    artifact_id: ARTIFACT,
    stage: 'first_frame',
    outcome: 'succeeded',
    duration_ms: 123,
  };
  for (const payload of [
    { ...body, user_id: OWNER },
    { ...body, url: 'fixture-secret-url' },
  ]) {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/image-plaza/playback-observations',
          headers: { 'x-test-user': OWNER },
          payload,
        })
      ).statusCode
    ).toBe(400);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/image-plaza/playback-observations',
        headers: { 'x-test-user': OTHER },
        payload: body,
      })
    ).statusCode
  ).toBe(404);
  expect(state.emit).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/image-plaza/playback-observations',
        headers: { 'x-test-user': OWNER },
        payload: body,
      })
    ).statusCode
  ).toBe(202);
  expect(state.emit).toHaveBeenCalledWith(
    'video.playback.observation',
    'video.delivery.playback',
    expect.objectContaining({ stage: 'first_frame', duration_ms: 123 })
  );
});
