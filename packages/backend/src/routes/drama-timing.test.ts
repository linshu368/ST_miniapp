import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaSigningObservation } from '../features/drama/signed-url.js';

const mocks = vi.hoisted(() => ({
  now: 0,
  denied: false,
  failDb: false,
  hasVideos: true,
  signOk: true,
  info: vi.fn(),
  metric: vi.fn(),
  sign: vi.fn(),
}));
const ID = '11111111-1111-4111-8111-111111111111';
const VIDEO = '22222222-2222-4222-8222-222222222222';
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (_request: FastifyRequest, reply: FastifyReply) => {
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
        videos: mocks.hasVideos
          ? [{ id: VIDEO, upload_succeeded: true, object_path: 'private-object-path' }]
          : [],
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
vi.mock('../features/drama/cover-url.js', () => ({
  buildCoverUrl: () => 'https://example.invalid/cover',
}));
vi.mock('../lib/logger.js', () => ({ requestLogger: () => ({ biz: { info: mocks.info } }) }));
vi.mock('@sentry/node', () => ({ metrics: { distribution: mocks.metric } }));
import dramaRoutes from './drama.js';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks, { now: 0, denied: false, failDb: false, hasVideos: true, signOk: true });
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
afterEach(() => vi.restoreAllMocks());

async function request(path = `/api/dramas/${ID}/play`) {
  const app = Fastify({ logger: false, genReqId: (req) => String(req.headers['x-request-id']) });
  await app.register(dramaRoutes);
  try {
    return await app.inject({ url: path, headers: { 'x-request-id': 'correlated-request' } });
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
    expect(JSON.stringify(mocks.metric.mock.calls)).not.toContain(ID);
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
