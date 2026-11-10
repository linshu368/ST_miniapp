import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaSigningObservation } from '../features/drama/signed-url.js';

const mocks = vi.hoisted(() => ({
  stream: false,
  streamSignFailed: false,
  now: 0,
  denied: false,
  failDb: false,
  hasVideos: true,
  dbStream: false,
  signOk: true,
  info: vi.fn(),
  metric: vi.fn(),
  sign: vi.fn(),
}));
const ID = '11111111-1111-4111-8111-111111111111';
const VIDEO = '22222222-2222-4222-8222-222222222222';
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (_request: FastifyRequest, reply: FastifyReply) => {
    _request.user = { id: 99999, first_name: 'Fixture' };
    mocks.now += 3;
    if (mocks.denied) return reply.status(401).send({ error: 'unauthorized' });
  },
}));
vi.mock('../features/drama/repository.js', () => ({
  DramaRepository: class {
    async getDramaForPlayback() {
      mocks.now += 20;
      if (mocks.failDb) throw new Error('drama playback read failed');
      return {
        id: ID,
        videos: !mocks.hasVideos
          ? []
          : mocks.dbStream
            ? [
                {
                  id: VIDEO,
                  upload_succeeded: true,
                  object_path: null,
                  storage_provider: 'cloudflare_stream',
                  stream_uid: 'ab'.repeat(16),
                  stream_ready_at: '2026-11-10T00:00:00Z',
                },
              ]
            : [{ id: VIDEO, upload_succeeded: true, object_path: 'private-object-path' }],
      };
    }
    async listDramas() {
      mocks.now += 10;
      return [];
    }
    async getDrama() {
      mocks.now += 15;
      return null;
    }
  },
}));
vi.mock('../features/drama/signed-url.js', () => ({
  DramaSignedUrlCache: class {
    getPlayUrl = mocks.sign;
  },
}));
vi.mock('../features/drama/stream.js', () => ({
  pinStreamDramas: (dramas: unknown[]) => dramas,
  selectStreamDelivery: () =>
    mocks.stream
      ? {
          config: {},
          video: { videoId: VIDEO, uid: 'unit' },
          delivery: {
            experimentId: 'stream-route-unit',
            group: 'stream',
            provider: 'stream',
            reason: 'assigned',
          },
        }
      : null,
  signStreamPlayback: () => {
    if (mocks.streamSignFailed) throw new Error('unit signing failure');
    return {
      playable: true,
      play_url: 'https://example.invalid/hls',
      expires_at: null,
      format: 'hls',
    };
  },
}));
vi.mock('../features/drama/cover-url.js', () => ({
  buildCoverUrl: () => 'https://example.invalid/cover',
}));
vi.mock('../lib/logger.js', () => ({ requestLogger: () => ({ biz: { info: mocks.info } }) }));
vi.mock('@sentry/node', () => ({ metrics: { distribution: mocks.metric } }));
import dramaRoutes from './drama.js';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks, {
    stream: false,
    streamSignFailed: false,
    now: 0,
    denied: false,
    failDb: false,
    hasVideos: true,
    dbStream: false,
    signOk: true,
  });
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.now);
  mocks.sign.mockImplementation(
    async (_path: string, _log: unknown, observation: DramaSigningObservation) => {
      mocks.now += 50;
      observation.cache = 'miss';
      return {
        playable: mocks.signOk,
        play_url: mocks.signOk ? 'https://example.invalid/video?token=private' : null,
        expires_at: null,
      };
    }
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function request(path = `/api/dramas/${ID}/play`, payload?: object) {
  const app = Fastify({ logger: false, genReqId: (req) => String(req.headers['x-request-id']) });
  await app.register(dramaRoutes);
  try {
    return await app.inject({
      method: payload ? 'POST' : 'GET',
      url: path,
      payload,
      headers: { 'x-request-id': 'correlated-request' },
    });
  } finally {
    await app.close();
  }
}

const logged = () => mocks.info.mock.calls.at(-1)?.[0];

describe('drama backend timing', () => {
  it('logs separate auth/read/sign stages with the incoming request ID and no credentials', async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(logged()).toMatchObject({
      event: 'drama.request_timing',
      request_id: 'correlated-request',
      auth_ms: 3,
      db_read_ms: 20,
      assemble_ms: 0,
      sign_ms: 50,
      sign_cache: 'miss',
      outcome: 'ok',
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('private');
    expect(mocks.metric).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it('records auth rejection without querying or signing', async () => {
    mocks.denied = true;
    expect((await request()).statusCode).toBe(401);
    expect(logged()).toMatchObject({ auth_ms: 3, outcome: 'http_error' });
    expect(logged().db_read_ms).toBeUndefined();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('records query failure with its failed stage', async () => {
    mocks.failDb = true;
    expect((await request()).statusCode).toBe(500);
    expect(logged()).toMatchObject({
      db_read_ms: 20,
      error_stage: 'db_read',
      outcome: 'http_error',
    });
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('covers no playable video and signature failure as distinct cases', async () => {
    mocks.hasVideos = false;
    expect((await request()).statusCode).toBe(200);
    expect(logged()).toMatchObject({ sign_cache: 'unused', outcome: 'unplayable' });
    expect(mocks.sign).not.toHaveBeenCalled();
    mocks.hasVideos = true;
    mocks.signOk = false;
    await request();
    expect(logged()).toMatchObject({
      sign_ms: 50,
      error_stage: 'sign',
      sign_cache: 'miss',
      outcome: 'unplayable',
    });
  });

  it('also times list, missing detail and invalid parameters', async () => {
    await request('/api/dramas');
    expect(logged()).toMatchObject({ db_read_ms: 10, assemble_ms: 0, status: 200 });
    await request(`/api/dramas/${ID}`);
    expect(logged()).toMatchObject({ db_read_ms: 15, status: 404 });
    await request('/api/dramas/invalid/play');
    expect(logged()).toMatchObject({ status: 400 });
    expect(logged().db_read_ms).toBeUndefined();
  });

  it('telemetry failure does not turn a valid playback response into an error', async () => {
    mocks.info.mockImplementationOnce(() => {
      throw new Error('logging failed');
    });
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.playback.playable).toBe(true);
  });
});

it.each(['', '?format=hls', '?format=hls&fallback=mp4'])(
  'serves Stream for a listed video through the legacy GET endpoint %s',
  async (query) => {
    mocks.stream = true;
    const result = await request(`/api/dramas/${ID}/play${query}`);
    expect(result.json().data.playback).toMatchObject({
      video_id: VIDEO,
      format: 'hls',
      delivery: { group: 'stream', provider: 'stream' },
    });
    expect(logged().delivery.provider).toBe('stream');
    expect(mocks.sign).not.toHaveBeenCalled();
  }
);
it('makes signing failure measurable without logging the signing exception', async () => {
  mocks.stream = true;
  mocks.streamSignFailed = true;
  const result = await request(`/api/dramas/${ID}/play?format=hls`);
  expect(result.json().data.playback).toMatchObject({
    playable: false,
    delivery: { group: 'stream', provider: 'unknown', reason: 'unavailable' },
  });
  expect(logged().delivery).toMatchObject({ provider: 'unknown', reason: 'unavailable' });
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('unit signing failure');
});

describe('Stream video stored in the database', () => {
  beforeEach(() => {
    mocks.dbStream = true;
    vi.stubEnv('DRAMA_STREAM_HOST', 'customer-unit.cloudflarestream.com');
    vi.stubEnv('DRAMA_STREAM_KEY_ID', 'unit-key');
    vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', 'unit-private-key');
  });

  it('signs HLS from the stored uid for any client and never touches the Supabase signer', async () => {
    for (const path of [
      `/api/dramas/${ID}/play`,
      `/api/dramas/${ID}/play?format=hls&fallback=mp4`,
    ]) {
      const result = await request(path);
      expect(result.json().data.playback).toMatchObject({
        video_id: VIDEO,
        playable: true,
        format: 'hls',
      });
      expect(result.json().data.playback.delivery).toBeUndefined();
    }
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('reports a signing failure as unplayable without an error status or a Supabase retry', async () => {
    mocks.streamSignFailed = true;
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.json().data.playback).toMatchObject({ playable: false, play_url: null });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(logged()).toMatchObject({ error_stage: 'sign', outcome: 'unplayable' });
  });

  it('is unplayable (not an error) while signing is not configured', async () => {
    vi.stubEnv('DRAMA_STREAM_PRIVATE_KEY', '');
    const result = await request();
    expect(result.json().data.playback).toMatchObject({ playable: false, play_url: null });
  });

  it('stage two refuses a legacy Supabase row', async () => {
    mocks.dbStream = false;
    vi.stubEnv('DRAMA_LEGACY_SUPABASE_ENABLED', 'false');
    const result = await request();
    expect(result.json().data.playback).toMatchObject({ playable: false, play_url: null });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});

describe('POST /api/dramas/play（固定地址，使 CORS 预检可缓存）', () => {
  const post = (payload: object) => request('/api/dramas/play', payload);

  it('returns the same playback as GET, no-store, and is measured under its own route', async () => {
    const response = await post({ drama_id: ID, video_id: VIDEO });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data.playback).toMatchObject({ video_id: VIDEO, playable: true });
    expect(logged()).toMatchObject({
      route: '/api/dramas/play',
      db_read_ms: 20,
      sign_ms: 50,
      outcome: 'ok',
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('private-object-path');
  });

  it('keeps the HLS capability declaration in the body', async () => {
    mocks.stream = true;
    const hls = await post({ drama_id: ID, format: 'hls' });
    expect(hls.json().data.playback).toMatchObject({ format: 'hls' });
    expect(mocks.sign).not.toHaveBeenCalled();
    const fallback = await post({ drama_id: ID, format: 'hls', fallback: 'mp4' });
    expect(fallback.json().data.playback.delivery).toMatchObject({
      provider: 'stream',
      reason: 'assigned',
    });
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and IDs before touching the database', async () => {
    for (const body of [
      { drama_id: 'invalid' },
      { drama_id: ID, video_id: 'invalid' },
      { drama_id: ID, extra: true },
      { video_id: VIDEO },
    ]) {
      expect((await post(body)).statusCode).toBe(400);
    }
    expect(logged().db_read_ms).toBeUndefined();
  });

  it('video that does not belong to the drama is 404', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect((await post({ drama_id: ID, video_id: other })).statusCode).toBe(404);
  });
});
