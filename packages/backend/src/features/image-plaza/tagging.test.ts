import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImagePlazaTagConfig } from '@miniapp/shared';
import {
  classifyImagePlazaTags,
  sanitizeImagePlazaTags,
  waitForImagePlazaTags,
} from './tagging.js';

const mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('../image/config.js', () => ({ getImageRuntimeConfig: mocks.config }));

const tags: ImagePlazaTagConfig = [
  { id: 'portrait', label: '肖像', enabled: true, sort_order: 0 },
  { id: 'landscape', label: '风景', enabled: true, sort_order: 1 },
  { id: 'disabled', label: '禁用', enabled: false, sort_order: 2 },
];
const log = pino({ enabled: false });
const textModel = {
  url: 'https://model.example.test/classify',
  apiKey: 'stub-credential',
  model: 'classifier',
  source: 'runtime',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ textModel });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('image plaza tagging', () => {
  it('filters ids, labels, disabled tags and duplicates, and caps output at 12', () => {
    expect(sanitizeImagePlazaTags(['portrait', 'portrait', '肖像', 'disabled', 3], tags)).toEqual([
      'portrait',
    ]);
    expect(sanitizeImagePlazaTags({ tags: ['portrait'] }, tags)).toEqual([]);
    const catalog = Array.from({ length: 20 }, (_, i) => ({
      id: `tag-${i}`,
      label: `标签${i}`,
      enabled: true,
      sort_order: i,
    }));
    expect(
      sanitizeImagePlazaTags(
        catalog.map((tag) => tag.id),
        catalog
      )
    ).toHaveLength(12);
  });

  it('sends only bounded prompt and enabled catalog, then sanitizes model output', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: '["portrait","portrait","disabled","unknown"]' } }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await classifyImagePlazaTags({ prompt: 'x'.repeat(2500), tags, log })).toEqual([
      'portrait',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(textModel.url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
      thinking: { type: string };
    };
    const input = JSON.parse(body.messages[1]!.content) as {
      description: string;
      tags: Array<{ id: string; label: string }>;
    };
    expect(input.description).toHaveLength(2000);
    expect(input.tags).toEqual(
      tags.filter((tag) => tag.enabled).map(({ id, label }) => ({ id, label }))
    );
    expect(body.model).toBe('classifier');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('does not read model config or call upstream when no tags are enabled', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    expect(await classifyImagePlazaTags({ prompt: 'portrait', tags: [], log })).toEqual([]);
    expect(mocks.config).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['http', () => new Response('private upstream details', { status: 503 })],
    ['invalid json', () => new Response('private upstream details')],
    ['invalid content', () => Response.json({ choices: [{ message: { content: 'not json' } }] })],
    ['oversized', () => new Response('x'.repeat(32769))],
  ])(
    'degrades %s responses to empty tags without leaking response body',
    async (_name, response) => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response()));
      const warn = vi.spyOn(log, 'warn');
      expect(await classifyImagePlazaTags({ prompt: 'private prompt', tags, log })).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(warn.mock.calls);
      expect(serialized).not.toContain('private');
      expect(serialized).not.toContain(textModel.apiKey);
    }
  );

  it('degrades missing config and transport failures without exposing credentials', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('private endpoint credential'));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(log, 'warn');
    mocks.config.mockResolvedValueOnce({ textModel: { ...textModel, apiKey: '' } });
    expect(await classifyImagePlazaTags({ prompt: 'portrait', tags, log })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await classifyImagePlazaTags({ prompt: 'portrait', tags, log })).toEqual([]);
    mocks.config.mockRejectedValueOnce(new Error('private config details'));
    expect(await classifyImagePlazaTags({ prompt: 'portrait', tags, log })).toEqual([]);
    for (const call of warn.mock.calls) {
      const record = call[0] as { err: Error };
      expect(record.err.message).toMatch(/^image_plaza_tagging_/);
      expect(record.err.message).not.toContain('private');
    }
  });

  it('returns fast results and clears the wait timer', async () => {
    vi.useFakeTimers();
    expect(await waitForImagePlazaTags(Promise.resolve(['portrait']))).toEqual(['portrait']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits at most 2 seconds without cancelling the same pending classification', async () => {
    vi.useFakeTimers();
    let resolve!: (value: string[]) => void;
    const pending = new Promise<string[]>((done) => {
      resolve = done;
    });
    const raced = waitForImagePlazaTags(pending);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await raced).toBeNull();
    resolve(['landscape']);
    expect(await pending).toEqual(['landscape']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
