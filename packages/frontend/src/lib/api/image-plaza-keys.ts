import type { ImagePlazaFeedSort } from '@miniapp/shared';

export const imagePlazaKeys = {
  all: ['image-plaza'] as const,
  config: () => [...imagePlazaKeys.all, 'config'] as const,
  feed: (
    search: string,
    tags: string | string[],
    sort: ImagePlazaFeedSort = 'recommended',
    media: 'all' | 'image' | 'video' = 'all'
  ) =>
    [
      ...imagePlazaKeys.all,
      'feed',
      2,
      search.trim(),
      Array.isArray(tags) ? [...tags].sort() : tags === 'all' ? [] : [tags],
      sort,
      media,
    ] as const,
  tagCounts: (search: string, media: 'all' | 'image' | 'video') =>
    [...imagePlazaKeys.all, 'tag-counts', search.trim(), media] as const,
  work: (id: string) => [...imagePlazaKeys.all, 'work', id] as const,
  conversations: () => [...imagePlazaKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...imagePlazaKeys.all, 'conversation', id] as const,
  videoAttempt: (id: string) => [...imagePlazaKeys.all, 'video-attempt', id] as const,
  videoPlayback: (id: string) => [...imagePlazaKeys.all, 'video-playback', id] as const,
  attempt: (id: string) => [...imagePlazaKeys.all, 'attempt', id] as const,
};
