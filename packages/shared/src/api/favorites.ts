import type { CharacterSummary } from './characters';

export interface CharacterFavoriteState {
  character_id: string;
  favorited: boolean;
  favorite_count: number;
}

export interface GetCharacterFavoriteIdsData {
  character_ids: string[];
}

export interface GetCharacterFavoritesData {
  characters: CharacterSummary[];
}

export interface SetCharacterFavoriteData {
  favorite: CharacterFavoriteState;
}
