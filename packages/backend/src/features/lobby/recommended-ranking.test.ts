import { DEFAULT_LOBBY_RANKING_PARAMS } from '@miniapp/shared';
import { describe, expect, it } from 'vitest';
import {
  LOBBY_COLD_START_BAND_END,
  LOBBY_COLD_START_BAND_START,
  applyPinnedOnly,
  buildRecommendedOrder as buildOrder,
  resolveFeaturedIds as resolveFeatured,
  type BuildRecommendedOrderInput,
} from './recommended-ranking.js';
import type { CardScore } from './ranking-stats.js';

const FEATURED_COUNT = 8;

/** 主池门槛现在由排序分快照带进来；这一组用例锁的是排布规则，仍按内置默认门槛断言 */
const LOBBY_RANKING_MIN_SAMPLE = DEFAULT_LOBBY_RANKING_PARAMS.min_users;

function buildRecommendedOrder<T extends { id: string }>(
  input: Omit<BuildRecommendedOrderInput<T>, 'minSample'> & { minSample?: number }
): T[] {
  return buildOrder({ minSample: LOBBY_RANKING_MIN_SAMPLE, ...input });
}

function resolveFeaturedIds<T extends { id: string }>(
  operatorOrdered: readonly T[],
  scores: ReadonlyMap<string, CardScore>,
  count: number,
  minSample: number = LOBBY_RANKING_MIN_SAMPLE,
  pinnedIds: readonly string[] = []
): Set<string> {
  return resolveFeatured(operatorOrdered, scores, count, minSample, pinnedIds);
}

function card(id: string) {
  return { id };
}

/** 样本达标的卡：只有分数不同 */
function mature(score: number): CardScore {
  return { score, sampleSize: 100 };
}

/** 样本不足的卡：分数再高也进不了主池 */
function cold(score = 100): CardScore {
  return { score, sampleSize: LOBBY_RANKING_MIN_SAMPLE - 1 };
}

/** 造 n 张卡，前 matureCount 张达标且分数递减，其余为冷启动卡 */
function fixture(total: number, matureCount: number) {
  const operatorOrdered = Array.from({ length: total }, (_, i) => card(`c${i}`));
  const scores = new Map<string, CardScore>();
  for (let i = 0; i < matureCount; i += 1) scores.set(`c${i}`, mature(total - i));
  return { operatorOrdered, scores };
}

describe('buildRecommendedOrder — 主池排序', () => {
  it('全量按分数降序，前八不再豁免运营顺序', () => {
    const operatorOrdered = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>(
      // 运营顺序越靠后分数越高：若还有前八豁免，c0 就会留在第一位
      operatorOrdered.map((c, i) => [c.id, mature(i)])
    );

    const ordered = buildRecommendedOrder({ operatorOrdered, scores, seed: 1 });

    expect(ordered.map((c) => c.id)).toEqual([...operatorOrdered].reverse().map((c) => c.id));
  });

  it('同分回落到运营顺序', () => {
    const operatorOrdered = Array.from({ length: 10 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>(operatorOrdered.map((c) => [c.id, mature(50)]));

    const ordered = buildRecommendedOrder({ operatorOrdered, scores, seed: 7 });

    expect(ordered.map((c) => c.id)).toEqual(operatorOrdered.map((c) => c.id));
  });
});

describe('buildRecommendedOrder — 冷启动池', () => {
  it('样本不足的卡进冷启动池，分数再高也不进主池头部', () => {
    const operatorOrdered = Array.from({ length: 60 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>();
    for (let i = 0; i < 50; i += 1) scores.set(`c${i}`, mature(60 - i));
    // 后十张样本不足但分数满分
    for (let i = 50; i < 60; i += 1) scores.set(`c${i}`, cold());

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 42,
    });

    const coldIds = new Set(Array.from({ length: 10 }, (_, i) => `c${50 + i}`));
    const bandStart = Math.round(LOBBY_COLD_START_BAND_START * 50);
    ordered.slice(0, bandStart).forEach((c) => {
      expect(coldIds.has(c.id)).toBe(false);
    });
  });

  it('完全没有评分记录的卡按冷启动处理', () => {
    const { operatorOrdered, scores } = fixture(40, 39);

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 5,
    });

    const rank = ordered.findIndex((c) => c.id === 'c39');
    expect(rank).toBeGreaterThanOrEqual(Math.round(LOBBY_COLD_START_BAND_START * 39));
  });

  it('冷启动卡落在主池长度的 30%–60% 区间内', () => {
    const { operatorOrdered, scores } = fixture(80, 70);

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 42,
    });

    const first = Math.round(LOBBY_COLD_START_BAND_START * 70);
    const last = Math.round(LOBBY_COLD_START_BAND_END * 70);
    for (let i = 70; i < 80; i += 1) {
      const position = ordered.findIndex((c) => c.id === `c${i}`);
      expect(position).toBeGreaterThanOrEqual(first);
      expect(position).toBeLessThanOrEqual(last);
    }
  });

  it('主池很短时冷启动卡也插不进金框区', () => {
    // 主池只有 10 张，30% 落在第 3 位——protectedPrefix 必须把它顶到第 8 位之后
    const operatorOrdered = Array.from({ length: 16 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>();
    for (let i = 0; i < 10; i += 1) scores.set(`c${i}`, mature(20 - i));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 3,
    });

    const coldIds = new Set(['c10', 'c11', 'c12', 'c13', 'c14', 'c15']);
    ordered.slice(0, FEATURED_COUNT).forEach((c) => {
      expect(coldIds.has(c.id)).toBe(false);
    });
  });

  it('冷启动卡多于区间宽度时向后撑开窗口，不挤占头部', () => {
    const operatorOrdered = Array.from({ length: 70 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>();
    for (let i = 0; i < 20; i += 1) scores.set(`c${i}`, mature(20 - i));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 11,
    });

    expect(ordered).toHaveLength(70);
    const coldIds = new Set(Array.from({ length: 50 }, (_, i) => `c${20 + i}`));
    ordered.slice(0, FEATURED_COUNT).forEach((c) => {
      expect(coldIds.has(c.id)).toBe(false);
    });
  });

  it('全部是冷启动卡时整体随机，不报错', () => {
    const operatorOrdered = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores: new Map(),
      protectedPrefix: FEATURED_COUNT,
      seed: 2,
    });

    expect(ordered).toHaveLength(12);
    expect(new Set(ordered.map((c) => c.id)).size).toBe(12);
  });
});

describe('buildRecommendedOrder — 随机性与完整性', () => {
  it('不传种子时每次调用重排，主池顺序保持不变', () => {
    const { operatorOrdered, scores } = fixture(80, 70);

    const runs = Array.from({ length: 12 }, () =>
      buildRecommendedOrder({ operatorOrdered, scores, protectedPrefix: FEATURED_COUNT })
    );

    // 冷卡位置逐次变化
    const signatures = new Set(runs.map((run) => run.map((c) => c.id).join(',')));
    expect(signatures.size).toBeGreaterThan(1);

    // 主池之间的相对顺序不受影响
    for (const run of runs) {
      const mainOrder = run.filter((c) => Number(c.id.slice(1)) < 70).map((c) => c.id);
      expect(mainOrder).toEqual(Array.from({ length: 70 }, (_, i) => `c${i}`));
    }
  });

  it('同一种子结果稳定，不同种子会重新洗牌', () => {
    const { operatorOrdered, scores } = fixture(80, 70);

    const build = (seed: number) =>
      buildRecommendedOrder({ operatorOrdered, scores, protectedPrefix: FEATURED_COUNT, seed })
        .map((c) => c.id)
        .join(',');

    expect(build(11)).toBe(build(11));
    expect(build(11)).not.toBe(build(12));
  });

  it('列表整体不丢卡也不重复', () => {
    const { operatorOrdered, scores } = fixture(55, 30);

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 9,
    });

    expect(ordered).toHaveLength(55);
    expect(new Set(ordered.map((c) => c.id)).size).toBe(55);
  });
});

describe('resolveFeaturedIds', () => {
  it('取主池分数最高的前 N 张', () => {
    const operatorOrdered = Array.from({ length: 20 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>(operatorOrdered.map((c, i) => [c.id, mature(i)]));

    const featured = resolveFeaturedIds(operatorOrdered, scores, FEATURED_COUNT);

    expect(featured).toEqual(new Set(['c19', 'c18', 'c17', 'c16', 'c15', 'c14', 'c13', 'c12']));
  });

  it('与列表实际排出的前 N 个位置一致', () => {
    const { operatorOrdered, scores } = fixture(80, 70);

    const featured = resolveFeaturedIds(operatorOrdered, scores, FEATURED_COUNT);
    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      seed: 4,
    });

    expect(new Set(ordered.slice(0, FEATURED_COUNT).map((c) => c.id))).toEqual(featured);
  });

  it('冷启动卡永远拿不到金框', () => {
    const operatorOrdered = Array.from({ length: 10 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>();
    scores.set('c0', mature(1));
    for (let i = 1; i < 10; i += 1) scores.set(`c${i}`, cold());

    expect(resolveFeaturedIds(operatorOrdered, scores, FEATURED_COUNT)).toEqual(new Set(['c0']));
  });
});

describe('运营固定位', () => {
  it('按配置顺序占据最前面，其余仍按分数降序', () => {
    const operatorOrdered = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
    // 分数与运营顺序同向递减，没有固定位时结果就是 c0…c11
    const scores = new Map<string, CardScore>(
      operatorOrdered.map((c, i) => [c.id, mature(12 - i)])
    );

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      pinnedIds: ['c9', 'c5'],
      seed: 3,
    });

    expect(ordered.slice(0, 2).map((c) => c.id)).toEqual(['c9', 'c5']);
    expect(ordered.slice(2).map((c) => c.id)).toEqual([
      'c0',
      'c1',
      'c2',
      'c3',
      'c4',
      'c6',
      'c7',
      'c8',
      'c10',
      'c11',
    ]);
  });

  it('固定位不会让任何卡重复或丢失', () => {
    const { operatorOrdered, scores } = fixture(60, 45);

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      pinnedIds: ['c50', 'c1', 'c59'],
      seed: 11,
    });

    expect(ordered).toHaveLength(60);
    expect(new Set(ordered.map((c) => c.id)).size).toBe(60);
  });

  it('配置里已下架/不存在的卡直接跳过，不占位也不报错', () => {
    const operatorOrdered = Array.from({ length: 5 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>(operatorOrdered.map((c, i) => [c.id, mature(5 - i)]));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      pinnedIds: ['ghost', 'c3'],
      seed: 3,
    });

    expect(ordered.map((c) => c.id)).toEqual(['c3', 'c0', 'c1', 'c2', 'c4']);
  });

  it('空固定位与不传固定位的结果逐字一致', () => {
    const { operatorOrdered, scores } = fixture(50, 40);
    const args = { operatorOrdered, scores, protectedPrefix: FEATURED_COUNT, seed: 8 } as const;

    expect(buildRecommendedOrder({ ...args, pinnedIds: [] }).map((c) => c.id)).toEqual(
      buildRecommendedOrder(args).map((c) => c.id)
    );
  });

  it('固定位全部拿到金框，剩余名额才按分数补齐', () => {
    const operatorOrdered = Array.from({ length: 20 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>(operatorOrdered.map((c, i) => [c.id, mature(i)]));

    const featured = resolveFeaturedIds(operatorOrdered, scores, FEATURED_COUNT, undefined, [
      'c0',
      'c1',
    ]);

    // c0/c1 分数最低，但固定位在前八，所以必须有金框；其余六个名额给分数最高的卡
    expect(featured).toEqual(new Set(['c0', 'c1', 'c19', 'c18', 'c17', 'c16', 'c15', 'c14']));
  });

  it('金框口径与列表实际排出的前八一致', () => {
    const { operatorOrdered, scores } = fixture(80, 70);
    const pinnedIds = ['c75', 'c2'];

    const featured = resolveFeaturedIds(
      operatorOrdered,
      scores,
      FEATURED_COUNT,
      undefined,
      pinnedIds
    );
    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      pinnedIds,
      seed: 4,
    });

    expect(new Set(ordered.slice(0, FEATURED_COUNT).map((c) => c.id))).toEqual(featured);
  });

  it('固定位数量顶满金框区时，冷启动卡照样进不了前八', () => {
    const operatorOrdered = Array.from({ length: 30 }, (_, i) => card(`c${i}`));
    const scores = new Map<string, CardScore>();
    for (let i = 0; i < 20; i += 1) scores.set(`c${i}`, mature(30 - i));
    for (let i = 20; i < 30; i += 1) scores.set(`c${i}`, cold());

    const pinnedIds = Array.from({ length: FEATURED_COUNT }, (_, i) => `c${i}`);
    const ordered = buildRecommendedOrder({
      operatorOrdered,
      scores,
      protectedPrefix: FEATURED_COUNT,
      pinnedIds,
      seed: 5,
    });

    expect(ordered.slice(0, FEATURED_COUNT).map((c) => c.id)).toEqual(pinnedIds);
  });

  it('applyPinnedOnly 只提固定位，其余保持运营顺序', () => {
    const operatorOrdered = Array.from({ length: 5 }, (_, i) => card(`c${i}`));

    expect(applyPinnedOnly(operatorOrdered, ['c3', 'ghost']).map((c) => c.id)).toEqual([
      'c3',
      'c0',
      'c1',
      'c2',
      'c4',
    ]);
    expect(applyPinnedOnly(operatorOrdered, []).map((c) => c.id)).toEqual(
      operatorOrdered.map((c) => c.id)
    );
  });
});

describe('主池门槛跟着排序分快照走', () => {
  const operatorOrdered = Array.from({ length: 6 }, (_, i) => card(`c${i}`));
  // 六张卡样本量都是 10：门槛 20 时全是冷启动卡，门槛 5 时全进主池
  const scores = new Map<string, CardScore>(
    operatorOrdered.map((c, i) => [c.id, { score: 100 - i, sampleSize: 10 }])
  );

  it('门槛高于样本量时整批走冷启动随机', () => {
    const runs = Array.from({ length: 12 }, () =>
      buildOrder({ operatorOrdered, scores, minSample: 20 })
        .map((c) => c.id)
        .join(',')
    );
    expect(new Set(runs).size).toBeGreaterThan(1);
    expect(resolveFeatured(operatorOrdered, scores, FEATURED_COUNT, 20).size).toBe(0);
  });

  it('门槛低于样本量时整批按分数降序，顺序确定', () => {
    const ordered = buildOrder({ operatorOrdered, scores, minSample: 5 });
    expect(ordered.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });
});
