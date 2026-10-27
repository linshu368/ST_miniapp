import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../platform/config.js';
import { queueVideo, retrieveVideo, VideoPlazaUpstreamError } from './video-upstream.js';

const originalImagePlaza = { ...config.imagePlaza };
const originalVenice = { ...config.venice };

beforeEach(() => {
  Object.assign(config.imagePlaza, {
    ...originalImagePlaza,
    apiKey: 'test-key',
    baseUrl: 'https://video.example.test/api/v1',
    timeoutMs: 1_000,
  });
  Object.assign(config.venice, { ...originalVenice, httpsProxy: '' });
});

afterEach(() => {
  Object.assign(config.imagePlaza, originalImagePlaza);
  Object.assign(config.venice, originalVenice);
  vi.unstubAllGlobals();
});

describe('video upstream', () => {
  it('sends only the documented queue fields and maps a queue id', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ queue_id: 'queue-1', download_url: 'https://cdn.example.test/a.mp4' })
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      queueVideo({
        providerModelId: 'wan-video',
        prompt: 'move',
        duration: 5,
        resolution: '1080p',
        aspectRatio: '16:9',
        audio: true,
        inputMode: 'i2v',
        referenceUrl: 'https://cdn.example.test/ref.png',
      })
    ).resolves.toEqual({ queueId: 'queue-1', downloadUrl: 'https://cdn.example.test/a.mp4' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'wan-video',
      prompt: 'move',
      image_url: 'https://cdn.example.test/ref.png',
    });
    expect(body).not.toHaveProperty('safe_mode');
    expect(body).not.toHaveProperty('auto_optimize');
  });

  it('marks an ambiguous queue transport failure unknown and never retries in-call', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', fetchMock);
    const error = await queueVideo({
      providerModelId: 'wan-video',
      prompt: 'move',
      duration: 5,
      resolution: '1080p',
      aspectRatio: null,
      audio: false,
      inputMode: 't2v',
      referenceUrl: null,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VideoPlazaUpstreamError);
    expect((error as VideoPlazaUpstreamError).disposition).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps retrieve policy rejection to a refundable moderation terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 422 }))
    );
    const error = await retrieveVideo({ providerModelId: 'wan-video', queueId: 'queue-1' }).catch(
      (value: unknown) => value
    );
    expect(error).toMatchObject({ code: 'video_moderation_rejected', disposition: 'refund' });
  });
});
