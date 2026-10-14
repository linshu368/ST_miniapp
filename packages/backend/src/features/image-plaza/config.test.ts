import { describe, expect, it } from 'vitest';
import { publicImagePlazaFeedTags, type ImagePlazaRuntimeConfig } from './config.js';

const baseTags = [
  { id: 'portrait', label: '人像', enabled: true, sort_order: 1 },
  { id: 'anime', label: '动漫', enabled: true, sort_order: 0 },
  { id: 'off', label: '关闭', enabled: false, sort_order: 2 },
] as ImagePlazaRuntimeConfig['tags'];

describe('publicImagePlazaFeedTags', () => {
  it('returns only all when tags feature is disabled', () => {
    expect(publicImagePlazaFeedTags({ tagsFeatureEnabled: false, tags: baseTags })).toEqual([
      { id: 'all', label: '全部' },
    ]);
  });

  it('returns enabled tags sorted when feature is on', () => {
    expect(publicImagePlazaFeedTags({ tagsFeatureEnabled: true, tags: baseTags })).toEqual([
      { id: 'all', label: '全部' },
      { id: 'anime', label: '动漫' },
      { id: 'portrait', label: '人像' },
    ]);
  });
});
