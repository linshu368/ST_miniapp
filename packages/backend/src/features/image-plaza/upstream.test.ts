import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../platform/config.js';
import { generateImagePlazaImage, stripUnsupportedImagePlazaPromptTags } from './upstream.js';

const originalProviderConfig = { ...config.imagePlaza };
const originalVeniceConfig = { ...config.venice };
/** 超过过小图阈值，避免单测被 content_rejected 误伤。 */
const validImageBytes = Buffer.alloc(5 * 1024, 7);

beforeEach(() => {
  Object.assign(config.imagePlaza, {
    ...originalProviderConfig,
    apiKey: 'test-api-key',
    baseUrl: 'https://images.example.test/api/v1',
    timeoutMs: 5_000,
  });
  // 单测走全局 fetch stub；清空代理避免误入 undici ProxyAgent 路径
  Object.assign(config.venice, { ...originalVeniceConfig, httpsProxy: '' });
});

afterEach(() => {
  Object.assign(config.imagePlaza, originalProviderConfig);
  Object.assign(config.venice, originalVeniceConfig);
  vi.unstubAllGlobals();
});

describe('stripUnsupportedImagePlazaPromptTags', () => {
  it('removes lora/lyco/hypernet angle-bracket tags and collapses spaces', () => {
    expect(
      stripUnsupportedImagePlazaPromptTags(
        'masterpiece, <lora:shiny_nai:1> 1girl, <lyco:foo:0.5> smile <hypernet:bar:1>'
      )
    ).toBe('masterpiece, 1girl, smile');
  });

  it('leaves ordinary prompts unchanged', () => {
    expect(stripUnsupportedImagePlazaPromptTags('1girl, red hair, smile')).toBe(
      '1girl, red hair, smile'
    );
  });
});

describe('generateImagePlazaImage', () => {
  it('strips LoRA tags from the outbound Venice prompt', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'request-lora', images: [validImageBytes.toString('base64')] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateImagePlazaImage({
      providerModelId: 'pixel-model',
      prompt: 'masterpiece, <lora:shiny_nai_ilxl_goofy_remade:1> 1girl, smile',
      aspectRatio: '2:3',
      resolution: 'fixed',
      sizingMode: 'pixels',
      mode: 't2i',
      autoOptimize: false,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.prompt).toBe('masterpiece, 1girl, smile');
  });

  it('uses controlled pixel dimensions for pixel-sized generation models', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'request-1', images: [validImageBytes.toString('base64')] })
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
      safe_mode: false,
      enhance_prompt: true,
      variants: 1,
      format: 'webp',
      width: 832,
      height: 1248,
    });
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(result.providerRequestId).toBe('request-1');
  });

  it('maps autoOptimize=false to enhance_prompt=false on generate', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'request-2', images: [validImageBytes.toString('base64')] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateImagePlazaImage({
      providerModelId: 'pixel-model',
      prompt: 'portrait',
      aspectRatio: '1:1',
      resolution: 'fixed',
      sizingMode: 'pixels',
      mode: 't2i',
      autoOptimize: false,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ safe_mode: false, enhance_prompt: false });
  });

  it('uses the Venice edit body and reads its binary response', async () => {
    const bytes = Buffer.alloc(5 * 1024, 4);
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
      autoOptimize: true,
      reference: { bytes: Buffer.from([9, 8, 7]), mimeType: 'image/png' },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe('https://images.example.test/api/v1/image/edit');
    expect(body).toEqual({
      model: 'edit-model',
      prompt: 'edit portrait',
      safe_mode: false,
      image: Buffer.from([9, 8, 7]).toString('base64'),
      aspect_ratio: '1:1',
      resolution: '2K',
      output_format: 'webp',
    });
    expect(body).not.toHaveProperty('enhance_prompt');
    expect(result).toMatchObject({ mimeType: 'image/png', providerRequestId: 'edit-request' });
    expect(result.bytes).toEqual(Buffer.from(bytes));
  });

  it('omits the resolution placeholder for aspect-ratio edit models', async () => {
    const bytes = Buffer.alloc(5 * 1024, 5);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/webp', 'x-request-id': 'lite-edit-request' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateImagePlazaImage({
      providerModelId: 'seedream-v5-lite-edit',
      prompt: 'edit portrait',
      aspectRatio: '1:1',
      resolution: 'fixed',
      sizingMode: 'aspect_ratio',
      mode: 'i2i',
      reference: { bytes: Buffer.from([9, 8, 7]), mimeType: 'image/png' },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'seedream-v5-lite-edit',
      prompt: 'edit portrait',
      safe_mode: false,
      image: Buffer.from([9, 8, 7]).toString('base64'),
      aspect_ratio: '1:1',
      output_format: 'webp',
    });
    expect(body).not.toHaveProperty('resolution');
  });

  it('rejects content-violation headers before settlement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: 'viol', images: [validImageBytes.toString('base64')] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-venice-is-content-violation': 'true',
          },
        })
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
      code: 'image_plaza_provider_content_rejected',
      outcomeUnknown: false,
    });
  });

  it('rejects suspiciously small provider images', async () => {
    const tiny = Buffer.alloc(1908, 0);
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: 'tiny', images: [tiny.toString('base64')] }))
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
      code: 'image_plaza_provider_content_rejected',
      outcomeUnknown: false,
    });
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
