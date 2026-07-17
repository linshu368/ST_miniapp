import type { CharacterCard } from './adminApi';

export function normalizeCharacterTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
}

export function getCharacterAvatarUrl(
  character: Pick<CharacterCard, 'id' | 'avatar_url'>,
  supabaseUrl: string
): string {
  const configured = character.avatar_url?.trim();
  if (configured) return configured;
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/character-assets/characters/platform_${character.id}.png`;
}
