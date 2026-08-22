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

  it('有排序分时，固定位先占，剩余名额按分数从主池补齐', () => {
    const snapshot = snapshotOf([
      ['a', mature(10)],
      ['b', mature(90)],
      ['c', mature(80)],
      ['d', mature(70)],
      ['e', mature(60)],
    ]);

    const featured = resolveLobbyFeaturedIds({
      operatorOrdered: pool,
      snapshot,
      pinnedIds: ['e'],
      count: 3,
    });

    // e 是固定位（分数最低也进），剩下两个名额给分数最高的 b、c
    expect(featured).toEqual(new Set(['e', 'b', 'c']));
  });

  it('排序分快照缺失时仍然认固定位，剩余名额回落运营顺序', () => {
    const featured = resolveLobbyFeaturedIds({
      operatorOrdered: pool,
      snapshot: null,
      pinnedIds: ['d'],
      count: 3,
    });

    expect(featured).toEqual(new Set(['d', 'a', 'b']));
  });

  it('固定位配满 count 时，主池一张都补不进来', () => {
    const snapshot = snapshotOf([
      ['a', mature(100)],
      ['b', mature(90)],
    ]);

    const featured = resolveLobbyFeaturedIds({
      operatorOrdered: pool,
      snapshot,
      pinnedIds: ['e', 'd'],
      count: 2,
    });

    expect(featured).toEqual(new Set(['e', 'd']));
  });

  it('固定位指向已下架/已删除的卡时跳过，不占名额也不报错', () => {
    const snapshot = snapshotOf([
      ['a', mature(10)],
      ['b', mature(90)],
    ]);

    const featured = resolveLobbyFeaturedIds({
      operatorOrdered: pool,
      snapshot,
      pinnedIds: ['ghost', 'a'],
      count: 2,
    });

    // ghost 不在候选池里，名额让给主池最高分的 b
    expect(featured).toEqual(new Set(['a', 'b']));
  });

  it('没有固定位时，有无快照两条路径都退回加固定位之前的行为', () => {
    const snapshot = snapshotOf([
      ['a', mature(10)],
      ['b', mature(90)],
      ['c', mature(80)],
    ]);

    expect(
      resolveLobbyFeaturedIds({ operatorOrdered: pool, snapshot, pinnedIds: [], count: 2 })
    ).toEqual(new Set(['b', 'c']));

    expect(
      resolveLobbyFeaturedIds({ operatorOrdered: pool, snapshot: null, pinnedIds: [], count: 2 })
    ).toEqual(new Set(['a', 'b']));
  });

  it('默认名额与大厅金框位数一致', () => {
    const featured = resolveLobbyFeaturedIds({
      operatorOrdered: Array.from({ length: 20 }, (_, i) => card(`c${i}`)),
      snapshot: null,
      pinnedIds: [],
    });

    expect(featured.size).toBe(LOBBY_FEATURED_POSITION_COUNT);
  });
});
