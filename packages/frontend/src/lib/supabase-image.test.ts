import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('testdb public transformation samples', () => {
  afterEach(() => vi.unstubAllEnvs());
  const test = 'https://zoqelpfhurwehlvypryl.supabase.co';
  const prod = 'https://wbtsfzozlmurljvglhpn.supabase.co';
  const object = '/storage/v1/object/public/';
  const render = '/storage/v1/render/image/public/';
  const size = { width: 360, height: 480 };

  it.each([
    'drama-covers/covers/065ff2e9-4eb7-5d6f-9b2f-d95ec98ff9c0/original.jpg',
    'character-assets/characters/platform_1691e6d7-cc11-4ceb-8718-db8a0bc583db.png',
  ])('only permits the exact bucket and object: %s', (path) => {
    vi.stubEnv('ST_LIMIT_TEST_IMAGE_TRANSFORMS', 'true');
    const source = test + object + path;
    expect(supabasePublicImageUrl(source, size)).toContain(test + render + path);
    expect(supabasePublicImageSrcSet(source, [240, 360], size)).toContain('360w');
    for (const other of [source + '.copy', test + object + 'another/' + path]) {
      expect(supabasePublicImageUrl(other, size)).toBe(other);
      expect(supabasePublicImageSrcSet(other, [240, 360], size)).toBeUndefined();
    }
  });

  it('restores a previous render URL without dropping non-transform query parameters', () => {
    vi.stubEnv('ST_LIMIT_TEST_IMAGE_TRANSFORMS', 'true');
    const source = test + render + 'other/file.jpg?width=480&quality=80&format=origin&v=2';
    expect(supabasePublicImageUrl(source, size)).toBe(test + object + 'other/file.jpg?v=2');
    expect(supabasePublicImageSrcSet(source, [240, 360], size)).toBeUndefined();
  });

  it('preserves exact production variants across deployment and source combinations', () => {
    for (const [flag, origin] of [
      ['false', prod],
      ['false', test],
      ['true', prod],
    ]) {
      vi.stubEnv('ST_LIMIT_TEST_IMAGE_TRANSFORMS', flag);
      const path = 'character-assets/characters/other.png';
      const expected = origin + render + path + '?width=360&height=480&resize=cover&quality=68';
      expect(supabasePublicImageUrl(origin + object + path, size)).toBe(expected);
      expect(supabasePublicImageSrcSet(origin + object + path, [360], size)).toBe(
        expected + ' 360w'
      );
    }
  });
});
