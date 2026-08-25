import type { FreeQuotaExhaustedDialogConfig } from '@miniapp/shared';

const CHARACTER_NAME_PLACEHOLDER = '{characterName}';
const MAX_CHARACTER_NAME_LENGTH = 7;
const TRUNCATED_CHARACTER_NAME_LENGTH = MAX_CHARACTER_NAME_LENGTH - 1;
const FALLBACK_CHARACTER_NAME = '当前角色';

export function formatFreeQuotaExhaustedNotice(
  config: FreeQuotaExhaustedDialogConfig,
  characterName: string | null | undefined
): string {
  const displayName = truncateCharacterName(characterName);
  return config.text.replaceAll(CHARACTER_NAME_PLACEHOLDER, displayName);
}

export function truncateCharacterName(characterName: string | null | undefined): string {
  const normalizedName = characterName?.trim() || FALLBACK_CHARACTER_NAME;
  const characters = Array.from(normalizedName);
  if (characters.length <= MAX_CHARACTER_NAME_LENGTH) return normalizedName;
  return `${characters.slice(0, TRUNCATED_CHARACTER_NAME_LENGTH).join('')}…`;
}
