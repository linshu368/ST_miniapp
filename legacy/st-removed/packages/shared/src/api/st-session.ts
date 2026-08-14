/**
 * ST Bridge 会话相关的对外数据契约。
 */

/**
 * POST /api/bridge/st-character/:characterId 的响应数据。
 *
 * 懒下发：前端进入 /tavern/<characterId> 时调用，确保「当前打开的这张卡」
 * 已落到该用户的 ST 数据目录，随后才 selectCharacter。
 */
export interface EnsureStCharacterData {
  characterId: string;
  /** 'written' 本次新下发 | 'skipped' 已缓存 | 'missing' storage 无此卡 */
  status: 'written' | 'skipped' | 'missing';
}
