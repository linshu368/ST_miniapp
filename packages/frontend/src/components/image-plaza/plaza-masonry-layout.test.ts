import { describe, expect, it } from 'vitest';
import type { PlazaFeedItem } from '@miniapp/shared';
import { placePlazaItems } from './plaza-masonry-layout';

const work = (id: string, ratio: number) =>
  ({ id, width: 100, height: ratio * 100 }) as PlazaFeedItem;
describe('plaza masonry stable shortest column', () => {
  it('fills a short column instead of assigning alternating tall/short works', () => {
    const items = [work('a', 3), work('b', 0.5), work('c', 0.5), work('d', 0.5)];
    const layout = placePlazaItems(items, 100, []);
    expect(layout.columns.map((column) => column.map(({ work }) => work.id))).toEqual([
      ['a'],
      ['b', 'c', 'd'],
    ]);
    expect(layout.columns[1]!.map(({ index }) => index)).toEqual([1, 2, 3]);
  });
  it('preserves all existing columns on append and width changes; a new list resets', () => {
    const items = Array.from({ length: 60 }, (_, n) => work(String(n), n % 3 === 0 ? 3 : 0.6));
    const first = placePlazaItems(items.slice(0, 20), 160, []);
    const next = placePlazaItems(items, 140, first.placements);
    expect(next.placements.slice(0, 20)).toEqual(first.placements);
    expect(new Set(next.placements.map((entry) => entry.id)).size).toBe(60);
    expect(placePlazaItems([work('new', 1)], 140, next.placements).placements).toEqual([
      { id: 'new', column: 0 },
    ]);
  });
});
