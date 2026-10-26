/**
 * backend / features / lobby / featured-snapshot.ts
 *
 * 角色详情、收藏列表共用的金框快照。
 *
 * 金框要用「全部在架卡的运营顺序」才能算，详情接口原来每个请求都现拉一遍全量 id，
 * 和 findFirst 并行各占一条 Prisma 连接。生产上这条全站共享的数据，
 * 成了池被打穿时的主要放大器（task 10-21 E19/E20）。这里收成进程内短快照：
 *
 * - TTL 2s（产品决策 2026-10-23：金框要接近实时，但要保住列表/详情的加载速度）。
 *   运营序（sort_order、上下架）最多晚 2s 生效；排序分、固定位各自带的 60s 内存缓存
 *   是它们自己的既有行为，没有改动；
 * - 不用 60s：运营改 sort_order 或上下架后，详情/收藏的金框要在秒级跟上；
 *   也不能每请求现查：池紧张时 2s 内的请求共用一次查询，能直接少占连接；
 * - single-flight：过期瞬间涌入的并发请求只触发一次查询，不在池紧张时再扇出；
 * - 刷新失败沿用上次成功结果（即使已过期）；连它都没有时返回空集——宁可少显示金框，
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

const FEATURED_SNAPSHOT_TTL_MS = 2_000;

/** at 只用于判断是否新鲜；过期后仍保留，作为刷新失败时的降级值 */
let lastGood: { at: number; ids: ReadonlySet<string> } | null = null;
let inflight: Promise<ReadonlySet<string>> | null = null;

/** 单测与运营改固定位后清缓存用 */
export function clearLobbyFeaturedSnapshot(): void {
  lastGood = null;
  inflight = null;
}

export async function loadLobbyFeaturedIdSet(log: FastifyBaseLogger): Promise<ReadonlySet<string>> {
  if (lastGood && Date.now() - lastGood.at < FEATURED_SNAPSHOT_TTL_MS) return lastGood.ids;
  if (inflight) return inflight;

  inflight = refresh(log).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function refresh(log: FastifyBaseLogger): Promise<ReadonlySet<string>> {
  const startedAt = Date.now();
  try {
    // 串行占池：金框刷新已有 single-flight，再并行会在那一瞬间占 2 条 Prisma 连接。
    // 排序分读有自己的缓存 + single-flight；固定位走 PostgREST，不与 Prisma 抢同池。
    const operatorOrdered = await prisma.character.findMany({
      where: { enabled: true, archived_at: null },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
      select: { id: true },
    });
    const snapshot = await loadCharacterRankingScores();
    const pinned = await resolveLobbyPinnedCharacters(log);

    const ids = resolveLobbyFeaturedIds({
      operatorOrdered,
      snapshot,
      pinnedIds: pinned.characterIds,
    });
    // 只记成功结果：失败时的空集一旦记下，会把「没金框」钉住整整一个 TTL。
    lastGood = { at: Date.now(), ids };
    return ids;
  } catch (err) {
    log.warn(
      {
        kind: 'sys',
        event: 'lobby_featured.snapshot_failed',
        err,
        durationMs: Date.now() - startedAt,
        hasStale: lastGood !== null,
      },
      '金框快照刷新失败，沿用上次成功结果或本次不显示金框'
    );
    return lastGood?.ids ?? new Set<string>();
  }
}
