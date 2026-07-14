import { describe, expect, it } from 'vitest';

import {
  LOBBY_FEATURED_CHARACTER_IDS,
  isLobbyFeaturedCharacter,
  partitionLobbyCharacters,
} from '../lobby-featured';

describe('lobby featured characters', () => {
  it('固定角色始终按配置顺序置顶，并从其余角色中移除', () => {
    const first = LOBBY_FEATURED_CHARACTER_IDS[0];
    const third = LOBBY_FEATURED_CHARACTER_IDS[2];
    const rows = [{ id: 'other-a' }, { id: third }, { id: first }, { id: 'other-b' }];

    const result = partitionLobbyCharacters(rows);

    expect(result.featured.map((row) => row.id)).toEqual([first, third]);
    expect(result.others.map((row) => row.id)).toEqual(['other-a', 'other-b']);
  });

  it('可识别固定角色并安全跳过缺失数据', () => {
    expect(isLobbyFeaturedCharacter(LOBBY_FEATURED_CHARACTER_IDS[7])).toBe(true);
    expect(isLobbyFeaturedCharacter('missing-character')).toBe(false);
    expect(partitionLobbyCharacters([{ id: 'other' }]).featured).toEqual([]);
  });
});
