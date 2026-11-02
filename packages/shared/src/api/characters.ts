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
  /** 全局精选资格；与个人轮换后的展示位置无关，列表和详情使用相同口径。 */
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
 * recommended：公共质量目录；启用个人轮换的客户端另按鉴权批次投影顺序。
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

/**
 * GET /api/characters/latest-badge 与 POST /api/characters/latest-seen 的响应体。
 * 只表示「有 / 无」本轮上新，不带条数。
 */
export interface LobbyLatestBadgeData {
  has_new: boolean;
}

/** Existing conversations render their bound creator version; lobby/detail without a session show current content. */
export interface GetCharacterByIdQuery {
  session_id?: string;
}
