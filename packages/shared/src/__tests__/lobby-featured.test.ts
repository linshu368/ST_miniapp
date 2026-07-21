import { describe, expect, it } from 'vitest';

import { LOBBY_FEATURED_POSITION_COUNT, markLobbyFeaturedByPosition } from '../lobby-featured';

describe('lobby featured characters', () => {
  it('按当前排序位置标记前八个角色，不绑定固定 UUID', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `character-${index}` }));
    const result = markLobbyFeaturedByPosition(rows);
    expect(result.filter((row) => row.is_featured)).toHaveLength(LOBBY_FEATURED_POSITION_COUNT);
    expect(result[7]?.is_featured).toBe(true);
    expect(result[8]?.is_featured).toBe(false);
  });
});
