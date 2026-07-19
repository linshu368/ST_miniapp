import { describe, expect, it } from 'vitest';
import {
  getCharacterAvatarUrl,
  layoutsEqual,
  moveCharacterId,
  normalizeCharacterTags,
  summarizeCharacterLayoutChanges,
} from './characterCards';

describe('character card display helpers', () => {
  it('keeps usable string tags only', () => {
    expect(normalizeCharacterTags(['温柔', '', 3, null, '理性'])).toEqual(['温柔', '理性']);
    expect(normalizeCharacterTags({ tag: 'invalid' })).toEqual([]);
  });

  it('moves one position or jumps with Shift semantics', () => {
    expect(moveCharacterId(['a', 'b', 'c'], 'b', 'up', false)).toEqual(['b', 'a', 'c']);
    expect(moveCharacterId(['a', 'b', 'c'], 'b', 'down', false)).toEqual(['a', 'c', 'b']);
    expect(moveCharacterId(['a', 'b', 'c'], 'c', 'up', true)).toEqual(['c', 'a', 'b']);
    expect(moveCharacterId(['a', 'b', 'c'], 'a', 'down', true)).toEqual(['b', 'c', 'a']);
    expect(moveCharacterId(['a', 'b'], 'a', 'up', false)).toEqual(['a', 'b']);
  });

  it('compares complete three-state layouts', () => {
    const layout = { listed_ids: ['a'], delisted_ids: ['b'], deleted_ids: ['c'] };
    expect(layoutsEqual(layout, { ...layout })).toBe(true);
    expect(layoutsEqual(layout, { ...layout, listed_ids: ['b'] })).toBe(false);
  });

  it('summarizes state transitions, restores, and listed reordering', () => {
    const changes = summarizeCharacterLayoutChanges(
      {
        listed_ids: ['b', 'a', 'd'],
        delisted_ids: ['c'],
        deleted_ids: ['e'],
      },
      {
        listed_ids: ['a', 'b', 'c'],
        delisted_ids: ['e'],
        deleted_ids: ['d'],
      }
    );
    expect(changes.listed).toEqual(['d']);
    expect(changes.delisted).toEqual(['c']);
    expect(changes.deleted).toEqual(['e']);
    expect(changes.restored).toEqual(['d']);
    expect(changes.reordered).toEqual(['b', 'a']);
  });

  it('uses configured avatars and falls back to the character asset path', () => {
    expect(
      getCharacterAvatarUrl(
        { id: 'character-1', avatar_url: 'https://cdn.example/avatar.png' },
        'https://project.supabase.co'
      )
    ).toBe('https://cdn.example/avatar.png');
    expect(
      getCharacterAvatarUrl({ id: 'character-1', avatar_url: '' }, 'https://project.supabase.co/')
    ).toBe(
      'https://project.supabase.co/storage/v1/object/public/character-assets/characters/platform_character-1.png'
    );
  });
});
