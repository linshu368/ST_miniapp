import { describe, expect, it } from 'vitest';
import { publicImagePlazaFeedTags, type ImagePlazaRuntimeConfig } from './config.js';

const baseTags = [
  {
    id: 'portrait',
    label: '人像',
    enabled: true,
    sort_order: 1,
    group_id: 'style',
    group_label: '风格',
    group_sort_order: 0,
    group_layout: 'chips',
  },
  {
    id: 'anime',
    label: '动漫',
    enabled: true,
    sort_order: 0,
    group_id: 'style',
    group_label: '风格',
    group_sort_order: 0,
    group_layout: 'chips',
  },
  {
    id: 'off',
    label: '关闭',
    enabled: false,
    sort_order: 2,
    group_id: 'style',
    group_label: '风格',
    group_sort_order: 0,
    group_layout: 'chips',
  },
] as ImagePlazaRuntimeConfig['tags'];

describe('publicImagePlazaFeedTags', () => {
  it('returns enabled tags sorted regardless of auto-tagging switch', () => {
    expect(publicImagePlazaFeedTags({ tags: baseTags })).toEqual([
      {
        id: 'all',
        label: '全部',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
        media_types: ['image', 'video'],
      },
      {
        id: 'anime',
        label: '动漫',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
        media_types: ['image', 'video'],
      },
      {
        id: 'portrait',
        label: '人像',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
        media_types: ['image', 'video'],
      },
    ]);
  });

  it('omits disabled tags and does not invent business tags when catalog is empty', () => {
    expect(publicImagePlazaFeedTags({ tags: [] })).toEqual([
      {
        id: 'all',
        label: '全部',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
        media_types: ['image', 'video'],
      },
    ]);
  });
});
