import { z } from 'zod';

// 列表页用的精简结构
export const CharacterSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  avatar_url: z.string(),
  personality_tags: z.array(z.string()),
  author_name: z.string(),
  is_featured: z.boolean(),
});
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

// 详情页 / 对话页用的完整结构
export interface CharacterDetail extends CharacterSummary {
  /** Public author space, available only when there are visible creator works. */
  public_creator_id?: string;
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
  /** Public recommended head; ids is an optional CSV to revalidate an existing head in place. */
  limit?: 12;
  ids?: string;
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

export const PublicCreatorSpaceQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict();

export interface PublicCreatorSpaceData {
  author_name: string;
  characters: (CharacterSummary & { like_count: number; favorite_count: number })[];
  page: number;
  has_more: boolean;
}
