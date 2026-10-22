/**
 * backend / features / lobby / featured-snapshot.ts
 *
 * 角色详情、收藏列表共用的金框快照。
 *
 * 金框要用「全部在架卡的运营顺序」才能算，详情接口原来每个请求都现拉一遍全量 id，
 * 和 findFirst 并行各占一条 Prisma 连接。生产上这条全站共享、一天才变一次的数据，
 * 成了池被打穿时的主要放大器（task 10-21 E19/E20）。这里把它收成进程内快照：
 *
 * - TTL 与 ranking-stats / pinned-characters 的 60s 对齐，避免三份缓存错位太久；
 * - single-flight：过期瞬间涌入的并发请求只触发一次查询，不在池紧张时再扇出；
 * - 刷新失败沿用旧快照；连旧快照都没有时返回空集——宁可少显示金框，
 *   也不能让详情接口因为一个装饰性标记失败。
 *
 * 判定本身仍走 resolveLobbyFeaturedIds，与大厅列表同源。
 * 大厅列表不用这里：它本来就要拉全量摘要，直接现算即可。
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/db.js';
import { resolveLobbyFeaturedIds } from './featured.js';
import { resolveLobbyPinnedCharacters } from './pinned-characters.js';
import { loadCharacterRankingScores } from './ranking-stats.js';

const FEATURED_SNAPSHOT_TTL_MS = 60_000;

let cache: { at: number; ids: ReadonlySet<string> } | null = null;
let inflight: Promise<ReadonlySet<string>> | null = null;

/** 单测与运营改固定位后清缓存用 */
export function clearLobbyFeaturedSnapshot(): void {
  cache = null;
  inflight = null;
}

export async function loadLobbyFeaturedIdSet(log: FastifyBaseLogger): Promise<ReadonlySet<string>> {
  if (cache && Date.now() - cache.at < FEATURED_SNAPSHOT_TTL_MS) return cache.ids;
  if (inflight) return inflight;

  inflight = refresh(log).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function refresh(log: FastifyBaseLogger): Promise<ReadonlySet<string>> {
  const startedAt = Date.now();
  try {
    const [operatorOrdered, snapshot, pinned] = await Promise.all([
      prisma.character.findMany({
        where: { enabled: true, archived_at: null },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
        select: { id: true },
      }),
      loadCharacterRankingScores(),
      resolveLobbyPinnedCharacters(log),
    ]);

    const ids = resolveLobbyFeaturedIds({
      operatorOrdered,
      snapshot,
      pinnedIds: pinned.characterIds,
    });
    // 只缓存成功结果：失败结果一旦缓存，会把「没金框」钉住整整一个 TTL。
    cache = { at: Date.now(), ids };
    return ids;
  } catch (err) {
    log.warn(
      {
        kind: 'sys',
        event: 'lobby_featured.snapshot_failed',
        err,
        durationMs: Date.now() - startedAt,
        hasStale: cache !== null,
      },
      '金框快照刷新失败，沿用旧快照或本次不显示金框'
    );
    return cache?.ids ?? new Set<string>();
  }
}
