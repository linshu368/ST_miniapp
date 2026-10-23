import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { GetImagePlazaFeedData, GetImagePlazaWorkData, ImagePlazaWork } from '@miniapp/shared';
import {
  imagePlazaKeys,
  patchImagePlazaLike,
  restoreImagePlazaLike,
  validateImagePlazaReference,
} from './image-plaza';
import {
  clearImagePlazaReturn,
  readImagePlazaReturn,
  restoreImagePlazaReturn,
  saveImagePlazaReturn,
} from '../image-plaza-return';

vi.mock('./client', () => ({ apiClient: vi.fn(), ApiClientError: class extends Error {} }));

function work(id: string): ImagePlazaWork {
  return {
    id,
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
