import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaRepository, DramaRow } from '../features/drama/repository.js';
import type { DramaSignedUrlCache } from '../features/drama/signed-url.js';
import type { DramaStreamManifestCache } from '../features/drama/stream-manifest-cache.js';

const mocks = vi.hoisted(() => ({
  selectStreamDelivery: vi.fn(),
  signStreamPlayback: vi.fn(),
}));
vi.mock('../features/drama/stream.js', () => ({
  selectStreamDelivery: mocks.selectStreamDelivery,
  signStreamPlayback: mocks.signStreamPlayback,
}));
vi.mock('../lib/supabase.js', () => ({}));
vi.mock('../platform/config.js', () => ({ config: { database: { target: 'test' } } }));

import { createDramaPlayHandler, type DramaRequestTiming, type DramaStage } from './drama-play.js';

const DRAMA_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = '22222222-2222-4222-8222-222222222222';
const STREAM_UID = 'stream-uid-fixture';

function playableVideo(id = VIDEO_ID) {
  return {
    id,
    episode: null,
    object_path: 'videos/x/original',
    upload_succeeded: true,
    cover_path: null,
    cover_upload_succeeded: true,
    original_title: '',
    original_tags: [],
    original_description: null,
    created_at: null,
  };
}

function drama(videos = [playableVideo()]): DramaRow {
  return {
    id: DRAMA_ID,
    title: '',
    tags: [],
    description: null,
    ai_title: null,
    ai_tags: [],
    ai_description: null,
    videos,
  };
}

function fakeRequest(userId = 1): FastifyRequest {
  return {
    user: { id: userId, first_name: 'fixture' },
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    header: vi.fn().mockReturnThis(),
    status: vi.fn((code: number) => {
      reply.statusCode = code;
      return reply;
    }),
    send: vi.fn((body: unknown) => body),
  };
  return reply as unknown as FastifyReply & { send: ReturnType<typeof vi.fn> };
}

async function measure<T>(
  request: FastifyRequest,
  stage: DramaStage,
  run: () => T | Promise<T>
): Promise<T> {
  return run();
}

function deps(
  overrides: {
    repo?: Partial<DramaRepository>;
    streamManifests?: Partial<DramaStreamManifestCache>;
    signedUrls?: Partial<DramaSignedUrlCache>;
  } = {}
) {
  const timings = new WeakMap<FastifyRequest, DramaRequestTiming>();
  const repo = { getDramaForPlayback: vi.fn().mockResolvedValue(drama()), ...overrides.repo };
  const streamManifests = { getManifest: vi.fn(), ...overrides.streamManifests };
  const signedUrls = { getPlayUrl: vi.fn(), ...overrides.signedUrls };
  return {
    repo: repo as unknown as DramaRepository,
    streamManifests: streamManifests as unknown as DramaStreamManifestCache,
    signedUrls: signedUrls as unknown as DramaSignedUrlCache,
    timings,
    measure,
  };
}

function registerRequest(
  timings: WeakMap<FastifyRequest, DramaRequestTiming>,
  request: FastifyRequest
) {
  timings.set(request, { stages: {}, sign: {}, manifest: {} });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => vi.unstubAllEnvs());

describe('createDramaPlayHandler — Stream 内联清单', () => {
  it('Stream 组命中缓存时，响应带 inline_manifest', async () => {
    mocks.selectStreamDelivery.mockReturnValue({
      config: {},
      video: { videoId: VIDEO_ID, uid: STREAM_UID },
      delivery: { experimentId: 'exp', group: 'stream', provider: 'stream', reason: 'assigned' },
    });
    mocks.signStreamPlayback.mockReturnValue({
      playable: true,
      play_url: 'https://customer-unit.cloudflarestream.com/token/manifest/video.m3u8',
      expires_at: '2026-11-09T00:00:00.000Z',
      format: 'hls',
    });
    const d = deps({
      streamManifests: { getManifest: vi.fn().mockResolvedValue('#EXTM3U\n...') },
    });
    const handler = createDramaPlayHandler(d);
    const request = fakeRequest();
    registerRequest(d.timings, request);
    const reply = fakeReply();

    await handler(request, reply, { dramaId: DRAMA_ID, options: { format: 'hls' } });

    const body = reply.send.mock.calls[0]![0];
    expect(body.data.playback.inline_manifest).toBe('#EXTM3U\n...');
    expect(body.data.playback.playable).toBe(true);
    expect(d.timings.get(request)!.manifest).toBeDefined();
  });

  it('缓存未命中/超时/拉取失败时，字段缺省，/play 其余部分不变、不抛错', async () => {
    mocks.selectStreamDelivery.mockReturnValue({
      config: {},
      video: { videoId: VIDEO_ID, uid: STREAM_UID },
      delivery: { experimentId: 'exp', group: 'stream', provider: 'stream', reason: 'assigned' },
    });
    mocks.signStreamPlayback.mockReturnValue({
      playable: true,
      play_url: 'https://customer-unit.cloudflarestream.com/token/manifest/video.m3u8',
      expires_at: '2026-11-09T00:00:00.000Z',
      format: 'hls',
    });
    const d = deps({
      streamManifests: { getManifest: vi.fn().mockResolvedValue(undefined) },
    });
    const handler = createDramaPlayHandler(d);
    const request = fakeRequest();
    registerRequest(d.timings, request);
    const reply = fakeReply();

    await handler(request, reply, { dramaId: DRAMA_ID, options: { format: 'hls' } });

    const body = reply.send.mock.calls[0]![0];
    expect('inline_manifest' in body.data.playback).toBe(false);
    expect(body.data.playback.playable).toBe(true);
    expect(body.data.playback.play_url).toContain('manifest/video.m3u8');
  });

  it('清单外的 Supabase 路径不触发清单缓存逻辑', async () => {
    const getManifest = vi.fn();
    const getPlayUrl = vi.fn().mockResolvedValue({
      playable: true,
      play_url: 'https://cdn.example/signed',
      expires_at: '2026-11-09T00:00:00.000Z',
    });
    const d = deps({
      streamManifests: { getManifest },
      signedUrls: { getPlayUrl },
    });
    const handler = createDramaPlayHandler(d);
    const request = fakeRequest();
    registerRequest(d.timings, request);
    const reply = fakeReply();

    // 未匹配清单，即使客户端支持 HLS 仍取 MP4
    await handler(request, reply, { dramaId: DRAMA_ID, options: { format: 'hls' } });

    expect(getManifest).not.toHaveBeenCalled();
    expect(getPlayUrl).toHaveBeenCalledTimes(1);
    const body = reply.send.mock.calls[0]![0];
    expect('inline_manifest' in body.data.playback).toBe(false);
  });

  it('Stream 签名失败时不触发清单缓存逻辑，响应降级为不可播', async () => {
    mocks.selectStreamDelivery.mockReturnValue({
      config: {},
      video: { videoId: VIDEO_ID, uid: STREAM_UID },
      delivery: { experimentId: 'exp', group: 'stream', provider: 'stream', reason: 'assigned' },
    });
    mocks.signStreamPlayback.mockImplementation(() => {
      throw new Error('drama_sign_failed');
    });
    const getManifest = vi.fn();
    const d = deps({ streamManifests: { getManifest } });
    const handler = createDramaPlayHandler(d);
    const request = fakeRequest();
    registerRequest(d.timings, request);
    const reply = fakeReply();

    await handler(request, reply, { dramaId: DRAMA_ID, options: { format: 'hls' } });

    expect(getManifest).not.toHaveBeenCalled();
    const body = reply.send.mock.calls[0]![0];
    expect(body.data.playback.playable).toBe(false);
  });
});

it('routes first, thirtieth, tail and an unlisted episode consistently for ordinary and sampling accounts', async () => {
  const stream = await vi.importActual<typeof import('../features/drama/stream.js')>(
    '../features/drama/stream.js'
  );
  mocks.selectStreamDelivery.mockImplementation(stream.selectStreamDelivery);
  mocks.signStreamPlayback.mockImplementation(stream.signStreamPlayback);
  const catalog = Array.from({ length: 31 }, (_, i) => ({
    dramaId: randomUUID(),
    videoId: randomUUID(),
    uid: i.toString(16).padStart(32, '0'),
  }));
  const experimentId = 'stream-cutover-test';
  vi.stubEnv(
    'DRAMA_STREAM_MANIFEST',
    JSON.stringify({ environment: 'test', videos: catalog.slice(0, 30) })
  );
  vi.stubEnv('DRAMA_STREAM_ENABLED', 'true');
  vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
  vi.stubEnv('DRAMA_STREAM_EXPERIMENT_ID', experimentId);
  vi.stubEnv('DRAMA_STREAM_EXPERIMENT_KEY', 'fixture-key-for-stream-routing-only');
  vi.stubEnv('DRAMA_STREAM_HOST', 'customer-unit.cloudflarestream.com');
  vi.stubEnv('DRAMA_STREAM_KEY_ID', 'unit-key');
  vi.stubEnv(
    'DRAMA_STREAM_PRIVATE_KEY',
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString()
  );
  vi.stubEnv('DRAMA_STREAM_ENROLLMENT_BPS', '0');
  vi.stubEnv(
    'DRAMA_STREAM_SAMPLING_COHORT',
    JSON.stringify({ experimentId, supabase: 1, stream: 2 })
  );
  const otherEpisode = { ...catalog[0]!, videoId: randomUUID() };
  const getPlayUrl = vi.fn().mockResolvedValue({
    playable: true,
    play_url: 'https://storage.example.test/signed',
    expires_at: null,
  });
  for (const [item, listed] of [
    [catalog[0]!, true],
    [catalog[29]!, true],
    [catalog[30]!, false],
    [otherEpisode, false],
  ] as const) {
    const d = deps({
      repo: {
        getDramaForPlayback: async () => ({
          ...drama([playableVideo(item.videoId)]),
          id: item.dramaId,
        }),
      },
      signedUrls: { getPlayUrl },
    });
    const handler = createDramaPlayHandler(d);
    // With this fixture key, 3 and 4 were in opposite hash buckets; 1 and 2 were forced.
    for (const userId of [1, 2, 3, 4]) {
      for (const options of [{}, { video_id: item.videoId, fallback: 'mp4' as const }]) {
        getPlayUrl.mockClear();
        const request = fakeRequest(userId);
        const reply = fakeReply();
        registerRequest(d.timings, request);
        await handler(request, reply, { dramaId: item.dramaId, options });
        const playback = reply.send.mock.calls[0]![0].data.playback;
        expect(playback.video_id).toBe(item.videoId);
        expect(new URL(playback.play_url).hostname).toBe(
          listed ? 'customer-unit.cloudflarestream.com' : 'storage.example.test'
        );
        expect(getPlayUrl).toHaveBeenCalledTimes(listed ? 0 : 1);
      }
    }
  }
});
