import type { CharacterSummary } from './characters';

/** 单张角色卡的收藏状态。 */
export interface CharacterFavoriteState {
  character_id: string;
  favorited: boolean;
}

/**
 * 收藏的角色卡 id 集合。首页、详情弹层和对话页共用这一份状态，
 * 保证同一张卡在任意入口显示一致。
 */
export interface GetCharacterFavoriteIdsData {
  character_ids: string[];
}

/** 收藏列表，按收藏时间倒序，复用大厅角色卡摘要结构。 */
export interface GetCharacterFavoritesData {
  characters: CharacterSummary[];
}

export interface SetCharacterFavoriteData {
  favorite: CharacterFavoriteState;
}
