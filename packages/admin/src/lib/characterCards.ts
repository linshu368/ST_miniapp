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

export function filterCharacters(characters: CharacterCard[], query: string): CharacterCard[] {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return characters;
  return characters.filter((character) => {
    const searchable = [
      character.name,
      character.id,
      character.creator,
      character.description,
      ...normalizeCharacterTags(character.tags),
    ]
      .join('\n')
      .toLocaleLowerCase();
    return searchable.includes(keyword);
  });
}

export interface CharacterLayoutChanges {
  listed: string[];
  delisted: string[];
  deleted: string[];
  restored: string[];
  reordered: string[];
}

export function summarizeCharacterLayoutChanges(
  current: CharacterLayoutValue,
  previous: CharacterLayoutValue | null
): CharacterLayoutChanges {
  if (!previous) {
    return { listed: [], delisted: [], deleted: [], restored: [], reordered: [] };
  }

  const previousState = new Map<string, keyof CharacterLayoutValue>();
  const currentState = new Map<string, keyof CharacterLayoutValue>();
  (Object.keys(previous) as Array<keyof CharacterLayoutValue>).forEach((state) => {
    previous[state].forEach((id) => previousState.set(id, state));
    current[state].forEach((id) => currentState.set(id, state));
  });

  return {
    listed: current.listed_ids.filter((id) => previousState.get(id) !== 'listed_ids'),
    delisted: current.delisted_ids.filter((id) => previousState.get(id) !== 'delisted_ids'),
    deleted: current.deleted_ids.filter((id) => previousState.get(id) !== 'deleted_ids'),
    restored: current.listed_ids
      .concat(current.delisted_ids)
      .filter((id) => previousState.get(id) === 'deleted_ids'),
    reordered: current.listed_ids.filter(
      (id, index) =>
        previousState.get(id) === 'listed_ids' &&
        previous.listed_ids.indexOf(id) !== index &&
        currentState.get(id) === 'listed_ids'
    ),
  };
}

export function getCharacterAvatarUrl(
  character: Pick<CharacterCard, 'id' | 'avatar_url'>,
  supabaseUrl: string
): string {
  const configured = character.avatar_url?.trim();
  if (configured) return configured;
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/character-assets/characters/platform_${character.id}.png`;
}
