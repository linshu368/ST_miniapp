import type { CharacterCard } from './adminApi';
import type { CharacterLayoutValue } from './adminApi';

export function normalizeCharacterTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
}

export type CharacterMoveDirection = 'up' | 'down';

export function moveCharacterId(
  ids: readonly string[],
  id: string,
  direction: CharacterMoveDirection,
  jump: boolean
): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const to = jump
    ? direction === 'up'
      ? 0
      : ids.length - 1
    : from + (direction === 'up' ? -1 : 1);
  if (to < 0 || to >= ids.length || to === from) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function layoutsEqual(left: CharacterLayoutValue, right: CharacterLayoutValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function charactersForIds(
  characters: CharacterCard[],
  ids: readonly string[]
): CharacterCard[] {
  const byId = new Map(characters.map((character) => [character.id, character]));
  return ids.flatMap((id) => {
    const character = byId.get(id);
    return character ? [character] : [];
  });
}

export function getCharacterAvatarUrl(
  character: Pick<CharacterCard, 'id' | 'avatar_url'>,
  supabaseUrl: string
): string {
  const configured = character.avatar_url?.trim();
  if (configured) return configured;
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/character-assets/characters/platform_${character.id}.png`;
}
