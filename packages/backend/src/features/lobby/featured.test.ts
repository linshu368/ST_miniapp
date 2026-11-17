import { DEFAULT_LOBBY_RANKING_PARAMS, LOBBY_FEATURED_POSITION_COUNT } from '@miniapp/shared';
import { describe, expect, it } from 'vitest';
import { resolveLobbyFeaturedIds } from './featured.js';
import type { CardScore, RankingSnapshot } from './ranking-stats.js';

const MIN_SAMPLE = DEFAULT_LOBBY_RANKING_PARAMS.min_users;

function card(id: string) {
  return { id };
}

function mature(score: number): CardScore {
  return { score, sampleSize: MIN_SAMPLE + 50 };
}

function snapshotOf(entries: Array<[string, CardScore]>): RankingSnapshot {
  return { scores: new Map(entries), minSample: MIN_SAMPLE };
}

/**
 * 这一组用例守的是「金框在三个接口里必须一致」。大厅列表、角色详情、收藏列表都调这一个
 * 函数，所以只要它自洽，三处就不会再出现「列表有金框、点进详情没有」的错位。
 */
describe('resolveLobbyFeaturedIds', () => {
  const pool = [card('a'), card('b'), card('c'), card('d'), card('e')];

  it('有快照取主池分数前 N，没有快照回落运营顺序前 N', () => {
    const snapshot = snapshotOf([
      ['a', mature(10)],
      ['b', mature(90)],
      ['c', mature(80)],
    ]);

    expect(resolveLobbyFeaturedIds({ operatorOrdered: pool, snapshot, count: 2 })).toEqual(
      new Set(['b', 'c'])
    );

    expect(resolveLobbyFeaturedIds({ operatorOrdered: pool, snapshot: null, count: 2 })).toEqual(
      new Set(['a', 'b'])
    );
  });

  it('默认名额与大厅金框位数一致', () => {
    const featured = resolveLobbyFeaturedIds({
      operatorOrdered: Array.from({ length: 20 }, (_, i) => card(`c${i}`)),
      snapshot: null,
    });

    expect(featured.size).toBe(LOBBY_FEATURED_POSITION_COUNT);
  });
});
