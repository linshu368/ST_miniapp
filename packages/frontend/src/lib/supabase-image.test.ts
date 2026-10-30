import { describe, expect, it } from 'vitest';

import { supabasePublicImageSrcSet, supabasePublicImageUrl } from './supabase-image';

describe('Supabase public image transformations', () => {
  it('rewrites a public object URL to a bounded render variant', () => {
    expect(
      supabasePublicImageUrl('https://example.supabase.co/storage/v1/object/public/covers/a.jpg', {
        width: 360,
        height: 480,
        quality: 68,
      })
    ).toBe(
      'https://example.supabase.co/storage/v1/render/image/public/covers/a.jpg?width=360&height=480&resize=cover&quality=68'
    );
  });

  it('keeps external images untouched instead of proxying them', () => {
    const source = 'https://images.example.com/a.jpg';
    expect(supabasePublicImageUrl(source, { width: 360, height: 480 })).toBe(source);
    expect(supabasePublicImageSrcSet(source, [240, 360], { width: 3, height: 4 })).toBeUndefined();
  });

  it('uses a finite responsive set with the requested aspect ratio', () => {
    const result = supabasePublicImageSrcSet(
      'https://example.supabase.co/storage/v1/object/public/covers/a.jpg',
      [240, 360],
      { width: 3, height: 4 }
    );
    expect(result).toContain('width=240&height=320');
    expect(result).toContain('width=360&height=480');
  });
});
