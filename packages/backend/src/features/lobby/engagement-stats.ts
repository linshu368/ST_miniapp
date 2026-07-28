import { prisma } from '../../lib/db.js';
import type { CharacterEngagement } from './recommended-ranking.js';

/** 与大厅接口的 CDN 缓存同宽度，避免每次请求都全表聚合 */
const ENGAGEMENT_CACHE_TTL_MS = 60_000;

interface EngagementRow {
  character_id: string;
  entered_users: bigint | number;
  converted_users: bigint | number;
}

let cache: { at: number; value: Map<string, CharacterEngagement> } | null = null;

export function clearCharacterEngagementCache(): void {
  cache = null;
}

/**
 * 读取每张角色卡的聊天转化率原始计数。
 * 视图缺失或聚合失败时返回 null，调用方应退回运营顺序，
 * 而不是把所有角色都当成新卡去随机插入。
 */
export async function loadCharacterEngagementStats(): Promise<Map<
  string,
  CharacterEngagement
> | null> {
  const now = Date.now();
  if (cache && now - cache.at < ENGAGEMENT_CACHE_TTL_MS) return cache.value;

  try {
    const rows = await prisma.$queryRaw<EngagementRow[]>`
      SELECT character_id, entered_users, converted_users
      FROM miniapp.character_engagement_stats
    `;

    const value = new Map<string, CharacterEngagement>();
    for (const row of rows) {
      value.set(row.character_id, {
        enteredUsers: Number(row.entered_users),
        convertedUsers: Number(row.converted_users),
      });
    }
    cache = { at: now, value };
    return value;
  } catch (error) {
    console.warn('[lobby] 读取角色转化率聚合失败，本次退回运营顺序', error);
    return cache?.value ?? null;
  }
}
