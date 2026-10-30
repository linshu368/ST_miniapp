import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../platform/config.js';
import {
  queueVideo,
  recommendedVideoPollDelayMs,
  retrieveVideo,
  VideoPlazaUpstreamError,
} from './video-upstream.js';

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
      duration: '5s',
      resolution: '1080p',
      image_url: 'https://cdn.example.test/ref.png',
    });
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('audio');
    expect(body).not.toHaveProperty('safe_mode');
    expect(body).not.toHaveProperty('auto_optimize');
  });

  it('sends audio only for the configurable opt-out', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ queue_id: 'queue-muted' }));
    vi.stubGlobal('fetch', fetchMock);
    await queueVideo({
      providerModelId: 'seedance-video',
      prompt: 'move',
      duration: 5,
      resolution: '720p',
      aspectRatio: '16:9',
      audio: false,
      inputMode: 't2v',
      referenceUrl: null,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      aspect_ratio: '16:9',
      audio: false,
    });
  });

  it('keeps aspect ratio and reference images for reference-to-video', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ queue_id: 'queue-reference' }));
    vi.stubGlobal('fetch', fetchMock);
    await queueVideo({
      providerModelId: 'seedance-reference-video',
      prompt: 'move',
      duration: 5,
      resolution: '720p',
      aspectRatio: '9:16',
      audio: true,
      inputMode: 'r2v',
      referenceUrl: 'https://cdn.example.test/ref.png',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      aspect_ratio: '9:16',
      reference_image_urls: ['https://cdn.example.test/ref.png'],
    });
  });

  it('keeps only a redacted validation summary for provider failures', async () => {
    const prompt = 'private prompt text';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: `Invalid request for ${prompt}`,
            details: { audio: { _errors: ['Field is not supported'] } },
          },
          { status: 400 }
        )
      )
    );
    const error = await queueVideo({
      providerModelId: 'minimax-h3-max-text-to-video',
      prompt,
      duration: 10,
      resolution: '1080P',
      aspectRatio: '16:9',
      audio: true,
      inputMode: 't2v',
      referenceUrl: null,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'video_provider_http_400',
      disposition: 'refund',
      upstream: {
        status: 400,
        message: 'Invalid request for [redacted]',
        fields: ['audio'],
      },
    });
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

  it('uses provider timing without allowing status polls beyond ten seconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status: 'PROCESSING',
          average_execution_time: 145_000,
          execution_duration: 53_200,
        })
      )
    );
    await expect(
      retrieveVideo({ providerModelId: 'wan-video', queueId: 'queue-1' })
    ).resolves.toEqual({
      kind: 'processing',
      averageExecutionTimeMs: 145_000,
      executionDurationMs: 53_200,
    });
    expect(
      recommendedVideoPollDelayMs({
        pollCount: 1,
        averageExecutionTimeMs: 145_000,
        executionDurationMs: 53_200,
      })
    ).toBe(10_000);
    expect(
      recommendedVideoPollDelayMs({
        pollCount: 9,
        averageExecutionTimeMs: null,
        executionDurationMs: null,
      })
    ).toBe(10_000);
    expect(
      recommendedVideoPollDelayMs({
        pollCount: 1,
        averageExecutionTimeMs: 60_000,
        executionDurationMs: 50_000,
      })
    ).toBe(5_000);
  });
});
