import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function fakeRequest(): FastifyRequest {
  return {
    user: { id: 1, first_name: 'fixture' },
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

describe('createDramaPlayHandler — Stream 内联清单', () => {
  it('Stream 组命中缓存时，响应带 inline_manifest', async () => {
    mocks.selectStreamDelivery.mockReturnValue({
      config: {},
      video: { uid: STREAM_UID },
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
      video: { uid: STREAM_UID },
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

  it('非 Stream（Supabase 回退）路径不触发清单缓存逻辑', async () => {
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

    // 不传 format: 'hls'，走 Supabase/Bunny 路径
    await handler(request, reply, { dramaId: DRAMA_ID, options: {} });

    expect(getManifest).not.toHaveBeenCalled();
    expect(getPlayUrl).toHaveBeenCalledTimes(1);
    const body = reply.send.mock.calls[0]![0];
    expect('inline_manifest' in body.data.playback).toBe(false);
  });

  it('mp4 回退（fallback=mp4）也不触发清单缓存逻辑', async () => {
    mocks.selectStreamDelivery.mockReturnValue({
      config: {},
      video: { uid: STREAM_UID },
      delivery: { experimentId: 'exp', group: 'stream', provider: 'stream', reason: 'assigned' },
    });
    const getManifest = vi.fn();
    const getPlayUrl = vi.fn().mockResolvedValue({
      playable: true,
      play_url: 'https://cdn.example/signed',
      expires_at: '2026-11-09T00:00:00.000Z',
    });
    const d = deps({ streamManifests: { getManifest }, signedUrls: { getPlayUrl } });
    const handler = createDramaPlayHandler(d);
    const request = fakeRequest();
    registerRequest(d.timings, request);
    const reply = fakeReply();

    await handler(request, reply, {
      dramaId: DRAMA_ID,
      options: { format: 'hls', fallback: 'mp4' },
    });

    expect(getManifest).not.toHaveBeenCalled();
    expect(getPlayUrl).toHaveBeenCalledTimes(1);
  });

  it('Stream 签名失败时不触发清单缓存逻辑，响应降级为不可播', async () => {
    mocks.selectStreamDelivery.mockReturnValue({
      config: {},
      video: { uid: STREAM_UID },
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
