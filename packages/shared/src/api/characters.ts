// 列表页用的精简结构
export interface CharacterSummary {
  id: string;
  name: string;
  /** 角色一句话氛围描述，卡片上截断展示 */
  description: string;
  avatar_url: string;
  /** 性格/特质标签，3-5 个，卡片和详情页都展示 */
  personality_tags: string[];
  /** 创作者展示名 */
  author_name: string;
  /** 是否属于大厅固定前八角色 */
  is_featured: boolean;
}

// 详情页 / 对话页用的完整结构
export interface CharacterDetail extends CharacterSummary {
  /** 角色开场第一句话 */
  greeting: string;
  /** 创作者写给读者的补充说明（可为空） */
  creator_notes: string;
}

/**
 * 首页角色列表排序页签。
 * recommended：运营固定前八 + 第九张起按聊天转化率，新卡冷启动随机插入中段。
 * latest：仅按角色最后上架时间倒序，不保留运营固定位。
 */
export type LobbySort = 'recommended' | 'latest';

export const LOBBY_SORTS: readonly LobbySort[] = ['recommended', 'latest'];

export const DEFAULT_LOBBY_SORT: LobbySort = 'recommended';

/** 非法或缺省的 sort 一律落回「推荐」，保持旧调用方行为不变 */
export function parseLobbySort(value: unknown): LobbySort {
  return LOBBY_SORTS.includes(value as LobbySort) ? (value as LobbySort) : DEFAULT_LOBBY_SORT;
}

// GET /api/characters 的查询参数
export interface GetCharactersQuery {
  sort?: LobbySort;
}

// GET /api/characters 的响应体
export interface GetCharactersData {
  characters: CharacterSummary[];
}

// GET /api/characters/:id 的响应体
export interface GetCharacterByIdData {
  character: CharacterDetail;
}
