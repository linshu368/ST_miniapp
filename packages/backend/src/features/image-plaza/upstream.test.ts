import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../platform/config.js';
import { generateImagePlazaImage } from './upstream.js';

const originalProviderConfig = { ...config.imagePlaza };

beforeEach(() => {
  Object.assign(config.imagePlaza, {
    ...originalProviderConfig,
    apiKey: 'test-api-key',
    baseUrl: 'https://images.example.test/api/v1',
    timeoutMs: 5_000,
  });
});

afterEach(() => {
  Object.assign(config.imagePlaza, originalProviderConfig);
  vi.unstubAllGlobals();
});

describe('generateImagePlazaImage', () => {
  it('uses controlled pixel dimensions for pixel-sized generation models', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'request-1', images: [Buffer.from([1, 2, 3]).toString('base64')] })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateImagePlazaImage({
      providerModelId: 'pixel-model',
      prompt: 'portrait',
      aspectRatio: '2:3',
      resolution: 'fixed',
      sizingMode: 'pixels',
      mode: 't2i',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'pixel-model',
      prompt: 'portrait',
      variants: 1,
      format: 'webp',
      width: 832,
      height: 1248,
    });
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(result.providerRequestId).toBe('request-1');
  });

  it('uses the Venice edit body and reads its binary response', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png', 'x-request-id': 'edit-request' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateImagePlazaImage({
      providerModelId: 'edit-model',
      prompt: 'edit portrait',
      aspectRatio: '1:1',
      resolution: '2K',
      sizingMode: 'resolution',
      mode: 'edit',
      reference: { bytes: Buffer.from([9, 8, 7]), mimeType: 'image/png' },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe('https://images.example.test/api/v1/image/edit');
    expect(body).toEqual({
      model: 'edit-model',
      prompt: 'edit portrait',
      image: Buffer.from([9, 8, 7]).toString('base64'),
      aspect_ratio: '1:1',
      resolution: '2K',
      output_format: 'webp',
    });
    expect(result).toMatchObject({ mimeType: 'image/png', providerRequestId: 'edit-request' });
    expect(result.bytes).toEqual(Buffer.from(bytes));
  });

  it('marks unreadable successful responses as an unknown provider outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
        )
    );

    await expect(
      generateImagePlazaImage({
        providerModelId: 'model',
        prompt: 'portrait',
        aspectRatio: '1:1',
        resolution: '1K',
        sizingMode: 'aspect_ratio',
        mode: 't2i',
      })
    ).rejects.toMatchObject({
      code: 'image_plaza_provider_outcome_unknown',
      outcomeUnknown: true,
    });
  });

  it('keeps explicit provider rejections retry-safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }))
    );

    await expect(
      generateImagePlazaImage({
        providerModelId: 'model',
        prompt: 'portrait',
        aspectRatio: '1:1',
        resolution: '1K',
        sizingMode: 'aspect_ratio',
        mode: 't2i',
      })
    ).rejects.toMatchObject({
      code: 'image_plaza_provider_http_429',
      outcomeUnknown: false,
    });
  });
});
