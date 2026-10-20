export const LOBBY_FEATURED_POSITION_COUNT = 8;

/** Flowing-gold styling belongs to the first eight displayed positions, not fixed IDs. */
export function markLobbyFeaturedByPosition<T>(
  characters: readonly T[]
): Array<T & { is_featured: boolean }> {
  return characters.map((character, index) => ({
    ...character,
    is_featured: index < LOBBY_FEATURED_POSITION_COUNT,
  }));
}
