import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type {
  GetImagePlazaFeedData,
  GetImagePlazaWorkData,
  ImagePlazaWork,
  ImagePlazaConversation,
} from '@miniapp/shared';
import * as plazaApi from './image-plaza';
import { imagePlazaFeedQueryOptions, prefetchImagePlazaFeed } from './image-plaza-feed';
import { apiClient } from './client';
import { createVideoCoverReference, latestConversationCover } from './video-cover-reference';
import {
  imagePlazaKeys,
  patchImagePlazaLike,
  restoreImagePlazaLike,
  validateImagePlazaReference,
  videoPlazaInputModeForReference,
} from './image-plaza';
import {
  clearImagePlazaReturn,
  readImagePlazaReturn,
  restoreImagePlazaReturn,
  saveImagePlazaReturn,
} from '../image-plaza-return';

vi.mock('./client', () => ({ apiClient: vi.fn(), ApiClientError: class extends Error {} }));

describe('feed priority and shared query identity', () => {
  afterEach(() => vi.mocked(apiClient).mockReset());
  it('joins an in-flight background prefetch without cancelling or sending twice', async () => {
    const client = new QueryClient();
    let resolve!: (value: GetImagePlazaFeedData) => void;
    vi.mocked(apiClient).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const prefetch = prefetchImagePlazaFeed(client);
    const visible = client.fetchInfiniteQuery(imagePlazaFeedQueryOptions('', [], 'recommended'));
    expect(apiClient).toHaveBeenCalledOnce();
    expect(apiClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ queuePriority: 'background' })
    );
    resolve({ items: [], tags: [], next_cursor: null });
    await Promise.all([prefetch, visible]);
    expect(apiClient).toHaveBeenCalledOnce();
    client.clear();
  });
  it('uses critical for the visible head and normal for its cursor pages', async () => {
    const client = new QueryClient();
    vi.mocked(apiClient)
      .mockResolvedValueOnce({ items: [], tags: [], next_cursor: 'fixture-next' })
      .mockResolvedValueOnce({ items: [], tags: [], next_cursor: null });
    await client.fetchInfiniteQuery({
      ...imagePlazaFeedQueryOptions('', [], 'recommended'),
      pages: 2,
    });
    expect(vi.mocked(apiClient).mock.calls.map((call) => call[1]?.queuePriority)).toEqual([
      'critical',
      'normal',
    ]);
    client.clear();
  });
});

describe('default video cover reference', () => {
  const conversation: ImagePlazaConversation = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'fixture',
    snapshot: null,
    messages: [],
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
  };
  const artifact = {
    id: '22222222-2222-4222-8222-222222222222',
    image_url: 'https://storage.example/reference.jpg',
    width: 512,
    height: 512,
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(apiClient).mockReset();
  });

  it('reads the authorized source-work cover and uploads an explicit reference before submit', async () => {
    const source = work('33333333-3333-4333-8333-333333333333');
    vi.mocked(apiClient).mockResolvedValueOnce({ work: source });
    const fetchCover = vi.fn(
      async () => new Response('fixture', { headers: { 'content-type': 'image/jpeg' } })
    );
    vi.stubGlobal('fetch', fetchCover);
    const payload = { image_base64: 'Zml4dHVyZQ==', mime_type: 'image/jpeg' as const };
    vi.spyOn(plazaApi, 'fileToImagePlazaPayload').mockResolvedValue(payload);
    const upload = vi.fn(async () => ({ artifact }));
    expect(
      await createVideoCoverReference(
        new QueryClient(),
        { ...conversation, source_work_id: source.id },
        null,
        upload
      )
    ).toEqual(artifact);
    expect(apiClient).toHaveBeenCalledWith(
      `/api/image-plaza/works/${source.id}`,
      expect.any(Object)
    );
    expect(fetchCover).toHaveBeenCalledWith(
      new URL(source.image_url),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    );
    expect(upload).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it('uses the selected retry cover before the conversation source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('fixture', { headers: { 'content-type': 'image/jpeg' } }))
    );
    vi.spyOn(plazaApi, 'fileToImagePlazaPayload').mockResolvedValue({
      image_base64: 'fixture',
      mime_type: 'image/jpeg',
    });
    await createVideoCoverReference(
      new QueryClient(),
      { ...conversation, source_work_id: conversation.id },
      'https://storage.example/retry.jpg',
      async () => ({ artifact })
    );
    expect(apiClient).not.toHaveBeenCalled();
  });

  it('rejects empty conversations before downloading or uploading anything', async () => {
    const upload = vi.fn();
    await expect(
      createVideoCoverReference(new QueryClient(), conversation, null, upload)
    ).rejects.toThrow('请先添加参考图');
    expect(upload).not.toHaveBeenCalled();
    expect(apiClient).not.toHaveBeenCalled();
  });

  it('uses the latest successful output in the current conversation as a cover', () => {
    const imageMessage = (id: string, url: string): ImagePlazaConversation['messages'][number] => ({
      id,
      role: 'assistant',
      content: '',
      media_type: 'image',
      video_attempt: null,
      created_at: conversation.created_at,
      attempt: {
        id,
        conversation_id: conversation.id,
        status: 'ready',
        quote_credits: 1,
        error_code: null,
        artifacts: [{ id, image_url: url, width: 512, height: 512 }],
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
      },
    });
    expect(
      latestConversationCover({
        ...conversation,
        messages: [
          imageMessage('first', 'https://storage.example/first.jpg'),
          imageMessage('latest', 'https://storage.example/latest.jpg'),
        ],
      })
    ).toBe('https://storage.example/latest.jpg');
  });

  it('propagates denied source-work access without trying another asset or uploading', async () => {
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('not authorized'));
    const upload = vi.fn();
    await expect(
      createVideoCoverReference(
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        { ...conversation, source_work_id: conversation.id },
        null,
        upload
      )
    ).rejects.toThrow('not authorized');
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    'http://storage.example/private.jpg',
    'https://name:secret@storage.example/private.jpg',
  ])('rejects unsafe cover URL %s without upload', async (url) => {
    const fetchCover = vi.fn();
    const upload = vi.fn();
    vi.stubGlobal('fetch', fetchCover);
    await expect(
      createVideoCoverReference(new QueryClient(), conversation, url, upload)
    ).rejects.toThrow('封面读取失败');
    expect(fetchCover).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('bounds cover size and never leaks a signed URL in an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('fixture', { headers: { 'content-length': String(21 * 1024 * 1024) } })
      )
    );
    const upload = vi.fn();
    await expect(
      createVideoCoverReference(
        new QueryClient(),
        conversation,
        'https://storage.example/cover.jpg?token=private',
        upload
      )
    ).rejects.toThrow('封面读取失败，请手动添加参考图');
    expect(upload).not.toHaveBeenCalled();
    expect(latestConversationCover(conversation)).toBeNull();
  });
});

describe('video quote input mode', () => {
  it.each([
    ['required_reference', false, 'r2v'],
    ['required_reference', true, 'r2v'],
    ['optional_reference', false, 't2v'],
    ['optional_reference', true, 'r2v'],
    ['optional_first_frame', false, 't2v'],
    ['optional_first_frame', true, 'i2v'],
    ['none', false, 't2v'],
    ['none', true, 't2v'],
    [undefined, false, 't2v'],
  ] as const)('quotes %s with reference=%s as %s', (input, reference, expected) => {
    expect(videoPlazaInputModeForReference(input, reference)).toBe(expected);
  });
});

function work(id: string): ImagePlazaWork {
  return {
    id,
    media_type: 'image',
    title: 'Example',
    image_url: 'https://example.com/image.png',
    reference_image_url: null,
    model_id: 'example',
    model_name: 'Example',
    width: 512,
    height: 512,
    tags: [],
    liked: false,
    like_count: 2,
    published_at: '2026-10-19T00:00:00Z',
    snapshot: {
      prompt: 'Example',
      model_id: 'example',
      aspect_ratio: '1:1',
      resolution: '1K',
      reasoning: false,
      auto_optimize: true,
      mode: 't2i',
      reference_artifact_id: null,
      style: 'None',
    },
  };
}

describe('image plaza field-level like cache updates', () => {
  it('patches every feed and detail, preserving pages, cursors and unrelated work updates on rollback', () => {
    const client = new QueryClient();
    const a = work('a');
    const b = work('b');
    const keys = [imagePlazaKeys.feed('', 'all'), imagePlazaKeys.feed('Example', 'portrait')];
    for (const key of keys)
      client.setQueryData<InfiniteData<GetImagePlazaFeedData>>(key, {
        pages: [{ items: [a, b], next_cursor: 'next', tags: [] }],
        pageParams: [undefined],
      });
    client.setQueryData<GetImagePlazaWorkData>(imagePlazaKeys.work('a'), { work: a });
    const snapshots = patchImagePlazaLike(client, 'a', () => ({ liked: true, like_count: 3 }));
    patchImagePlazaLike(client, 'b', () => ({ liked: true, like_count: 5 }));
    expect(client.getQueryData<GetImagePlazaWorkData>(imagePlazaKeys.work('a'))?.work.liked).toBe(
      true
    );
    restoreImagePlazaLike(client, 'a', snapshots);
    for (const key of keys) {
      const feed = client.getQueryData<InfiniteData<GetImagePlazaFeedData>>(key);
      expect(feed?.pages[0]?.items).toEqual([a, { ...b, liked: true, like_count: 5 }]);
      expect(feed?.pages[0]?.next_cursor).toBe('next');
      expect(feed?.pageParams).toEqual([undefined]);
    }
    expect(client.getQueryData<GetImagePlazaWorkData>(imagePlazaKeys.work('a'))?.work).toEqual(a);
    client.clear();
  });

  it('does not create empty caches and uses server confirmation without changing content', () => {
    const client = new QueryClient();
    expect(patchImagePlazaLike(client, 'absent', () => ({ liked: true, like_count: 1 }))).toEqual(
      []
    );
    const a = work('a');
    client.setQueryData<GetImagePlazaWorkData>(imagePlazaKeys.work('a'), { work: a });
    patchImagePlazaLike(client, 'a', () => ({ liked: true, like_count: 10 }));
    expect(client.getQueryData<GetImagePlazaWorkData>(imagePlazaKeys.work('a'))?.work).toEqual({
      ...a,
      liked: true,
      like_count: 10,
    });
    client.clear();
  });
});

describe('reference validation before preview/read', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts %s', (type) => {
    expect(validateImagePlazaReference(new File(['image'], 'reference', { type }))).toBe(type);
  });
  it('rejects empty, unsupported and oversized files', () => {
    expect(() => validateImagePlazaReference(new File([], 'empty', { type: 'image/png' }))).toThrow(
      '不能为空'
    );
    expect(() =>
      validateImagePlazaReference(new File(['gif'], 'image', { type: 'image/gif' }))
    ).toThrow('仅支持');
    expect(() =>
      validateImagePlazaReference(
        new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large', { type: 'image/png' })
      )
    ).toThrow('20MB');
  });
});

describe('image plaza return continuity', () => {
  afterEach(() => {
    clearImagePlazaReturn();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function scene(entries: { id: string; top: number }[]) {
    const visible = entries.map(({ id, top }) => ({
      dataset: { imageWorkId: id },
      getBoundingClientRect: () => ({ top, bottom: top + 200 }),
    }));
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollY: 500, innerHeight: 800, scrollTo });
    vi.stubGlobal('document', {
      querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 80 }) }),
      querySelectorAll: () => visible,
      documentElement: { scrollHeight: 2000 },
    });
    return scrollTo;
  }

  it('restores filters and the selected card without keeping DTOs or pagination cursors', () => {
    scene([
      { id: 'a', top: 100 },
      { id: 'b', top: 600 },
    ]);
    saveImagePlazaReturn({ search: '山海', tag: 'landscape', sort: 'latest' }, 'b');
    const saved = readImagePlazaReturn();
    expect(saved).toMatchObject({
      search: '山海',
      tag: 'landscape',
      sort: 'latest',
      anchorId: 'b',
    });
    expect(saved).not.toHaveProperty('items');
    expect(saved).not.toHaveProperty('cursor');
    const scrollTo = scene([
      { id: 'a', top: 200 },
      { id: 'b', top: 900 },
    ]);
    restoreImagePlazaReturn(saved!);
    expect(scrollTo).toHaveBeenCalledWith({ top: 800, left: 0, behavior: 'auto' });
  });

  it('uses the neighbor own original position when the selected work is unavailable', () => {
    scene([
      { id: 'a', top: 100 },
      { id: 'b', top: 600 },
    ]);
    saveImagePlazaReturn({ search: '', tag: 'all', sort: 'recommended' }, 'b');
    const saved = readImagePlazaReturn();
    const scrollTo = scene([{ id: 'a', top: 200 }]);
    restoreImagePlazaReturn(saved!);
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, left: 0, behavior: 'auto' });
  });

  it('clamps missing-anchor fallback and rejects expired state', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    scene([{ id: 'a', top: 100 }]);
    saveImagePlazaReturn({ search: '', tag: 'all', sort: 'recommended' });
    const saved = readImagePlazaReturn();
    const scrollTo = scene([]);
    restoreImagePlazaReturn({ ...saved!, scrollY: 5000 });
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, left: 0, behavior: 'auto' });
    clock.mockReturnValue(1000 + 2 * 60 * 60_000 + 1);
    expect(readImagePlazaReturn()).toBeNull();
  });
});
