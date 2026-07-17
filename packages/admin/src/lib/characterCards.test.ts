import { describe, expect, it } from 'vitest';
import { getCharacterAvatarUrl, normalizeCharacterTags } from './characterCards';

describe('character card display helpers', () => {
  it('keeps usable string tags only', () => {
    expect(normalizeCharacterTags(['温柔', '', 3, null, '理性'])).toEqual(['温柔', '理性']);
    expect(normalizeCharacterTags({ tag: 'invalid' })).toEqual([]);
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
