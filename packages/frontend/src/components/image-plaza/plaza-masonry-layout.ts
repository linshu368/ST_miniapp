import type { PlazaFeedItem } from '@miniapp/shared';
export type Placement = { id: string; column: number };

/** Existing assignments survive appends, cache updates and container width changes. */
export function placePlazaItems(
  items: readonly PlazaFeedItem[],
  width: number,
  previous: Placement[]
) {
  const valid = previous.every((entry, index) => items[index]?.id === entry.id);
  const placements = valid ? previous.slice(0, items.length) : [];
  const heights = [0, 0];
  const columns: Array<Array<{ work: PlazaFeedItem; index: number }>> = [[], []];
  items.forEach((work, index) => {
    const column = placements[index]?.column ?? (heights[0]! <= heights[1]! ? 0 : 1);
    placements[index] = { id: work.id, column };
    columns[column]!.push({ work, index });
    // Card controls are overlays; only the reserved ratio and 12px gap affect flow height.
    heights[column]! +=
      width * (work.width > 0 && work.height > 0 ? work.height / work.width : 1.5) + 12;
  });
  return { placements, columns };
}
