/**
 * backend / features / lobby / featured.ts
 *
 * 金框（is_featured）判定的唯一出口。
 *
 * 金框是位置属性，不是卡本身的属性，所以它必须由「整份大厅候选池 + 排序分快照 + 运营固定位」
 * 一起算出来。三个接口都要用：大厅列表、角色详情、收藏列表。三处各写一遍的话，只要有一处
 * 兜底分支写歪，就会出现「大厅有金框、点进详情没有」这种最难在测试里被发现的错位——得同时
 * 打开两个页面对比才看得出来。收藏页此前就是这么错开的：它按 sort_order 前八算，而大厅
 * 早在 v3 就换成了排序分。
 *
 * 所以这里连「排序分快照拿不到时怎么办」一并收进来，调用方只管把快照原样传进来。
 */

import { LOBBY_FEATURED_POSITION_COUNT } from '@miniapp/shared';
import type { RankingSnapshot } from './ranking-stats.js';
import { applyPinnedOnly, resolveFeaturedIds } from './recommended-ranking.js';

export interface ResolveLobbyFeaturedIdsInput<T> {
  /** 运营顺序（sort_order）排好的全部在架卡，不能只传当前页 */
  operatorOrdered: readonly T[];
  /** 排序分快照；刷新 job 还没跑过第一轮或查询失败时为 null */
  snapshot: RankingSnapshot | null;
  /** 运营点选的固定位，按展示顺序 */
  pinnedIds: readonly string[];
  count?: number;
}

export function resolveLobbyFeaturedIds<T extends { id: string }>(
  input: ResolveLobbyFeaturedIdsInput<T>
): Set<string> {
  const { operatorOrdered, snapshot, pinnedIds, count = LOBBY_FEATURED_POSITION_COUNT } = input;

  if (snapshot) {
    return resolveFeaturedIds(
      operatorOrdered,
      snapshot.scores,
      count,
      snapshot.minSample,
      pinnedIds
    );
  }

  // 分数没有也要认固定位：运营点的主推位与打分无关，不该被刷新 job 的状态连带拖掉。
  // 剩下的名额回落运营顺序，与 v3 之前的行为一致。
  return new Set(
    applyPinnedOnly(operatorOrdered, pinnedIds)
      .slice(0, count)
      .map((item) => item.id)
  );
}
