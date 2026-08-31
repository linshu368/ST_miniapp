import { getDomainDb } from '../../lib/supabase.js';

export interface CharacterFavoriteRow {
  character_id: string;
  created_at: string;
}

export interface CharacterFavoriteStateRow {
  character_id: string;
  favorited: boolean;
}

/**
 * 角色卡收藏读写。全部经由 miniapp schema 的 SECURITY DEFINER RPC，
 * 收藏列表的可用性过滤和重复收藏收敛都在数据库侧完成。
 */
export class MiniappCharacterFavoriteRepository {
  private readonly db = getDomainDb('miniapp_features');

  async list(userId: string): Promise<CharacterFavoriteRow[]> {
    const { data, error } = await this.db.rpc('list_character_favorites', {
      p_user_id: userId,
    });
    if (error) throw new Error(`查询角色收藏失败：${error.message}`);
    return (data ?? []) as CharacterFavoriteRow[];
  }

  async set(
    userId: string,
    characterId: string,
    favorited: boolean
  ): Promise<CharacterFavoriteStateRow> {
    const { data, error } = await this.db.rpc('set_character_favorite', {
      p_user_id: userId,
      p_character_id: characterId,
      p_favorited: favorited,
    });
    if (error) throw new Error(`更新角色收藏失败：${error.message}`);
    return data as CharacterFavoriteStateRow;
  }
}
