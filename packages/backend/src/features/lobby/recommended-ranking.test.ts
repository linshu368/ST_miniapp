import { describe, expect, it } from 'vitest';
import {
  LOBBY_COLD_START_MIN_ENTERED_USERS,
  LOBBY_COLD_START_SLOT_FIRST,
  LOBBY_COLD_START_SLOT_LAST,
  buildRecommendedOrder,
  conversionRate,
  dailyShuffleSeed,
  type CharacterEngagement,
} from './recommended-ranking.js';

const FIXED_COUNT = 8;

function card(id: string) {
  return { id };
}

/** 造一批达标角色：进入人数固定 100，转化人数决定转化率 */
function mature(convertedUsers: number): CharacterEngagement {
  return { enteredUsers: 100, convertedUsers };
}

describe('conversionRate', () => {
  it('用聊满 5 轮人数除以进入聊天人数', () => {
    expect(conversionRate({ enteredUsers: 100, convertedUsers: 60 })).toBeCloseTo(0.6);
  });

  it('没有进入人数时按 0 处理，不产生 NaN', () => {
    expect(conversionRate({ enteredUsers: 0, convertedUsers: 0 })).toBe(0);
  });
});

describe('buildRecommendedOrder', () => {
  it('前八张保持运营顺序，不参与动态排序', () => {
    const operatorOrdered = Array.from({ length: 20 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>(
      // 让靠后的角色转化率最高，若前八参与排序就会被顶上来
      operatorOrdered.map((c, i) => [c.id, mature(i)])
    );

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 1,
    });

    expect(ordered.slice(0, FIXED_COUNT).map((c) => c.id)).toEqual(
      operatorOrdered.slice(0, FIXED_COUNT).map((c) => c.id)
    );
  });

  it('第九张起按转化率从高到低', () => {
    const operatorOrdered = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>([
      ['c8', mature(10)],
      ['c9', mature(90)],
      ['c10', mature(50)],
      ['c11', mature(70)],
    ]);
    // 前八也要达标，否则会被当成新卡
    for (let i = 0; i < 8; i += 1) engagement.set(`c${i}`, mature(1));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 1,
    });

    expect(ordered.slice(FIXED_COUNT).map((c) => c.id)).toEqual(['c9', 'c11', 'c10', 'c8']);
  });

  it('同转化率时沿用运营顺序作为次级顺序', () => {
    const operatorOrdered = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>(
      operatorOrdered.map((c) => [c.id, mature(40)])
    );

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 7,
    });

    expect(ordered.map((c) => c.id)).toEqual(operatorOrdered.map((c) => c.id));
  });

  it('不足 10 人次的新卡不能进入前 30 名', () => {
    const operatorOrdered = Array.from({ length: 80 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>();
    for (let i = 0; i < 70; i += 1) engagement.set(`c${i}`, mature(80 - i));
    // 后十张是新卡：即使转化率 100% 也不能靠前
    for (let i = 70; i < 80; i += 1) {
      engagement.set(`c${i}`, {
        enteredUsers: LOBBY_COLD_START_MIN_ENTERED_USERS - 1,
        convertedUsers: 9,
      });
    }

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 42,
    });

    const coldIds = new Set(Array.from({ length: 10 }, (_, i) => `c${70 + i}`));
    ordered.slice(0, LOBBY_COLD_START_SLOT_FIRST - 1).forEach((c) => {
      expect(coldIds.has(c.id)).toBe(false);
    });
  });

  it('新卡落在第 31–60 名区间内', () => {
    const operatorOrdered = Array.from({ length: 80 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>();
    for (let i = 0; i < 70; i += 1) engagement.set(`c${i}`, mature(80 - i));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 42,
    });

    for (let i = 70; i < 80; i += 1) {
      const rank = ordered.findIndex((c) => c.id === `c${i}`) + 1;
      expect(rank).toBeGreaterThanOrEqual(LOBBY_COLD_START_SLOT_FIRST);
      expect(rank).toBeLessThanOrEqual(LOBBY_COLD_START_SLOT_LAST);
    }
  });

  it('插入新卡后原有角色顺延，转化率最低的落到末尾（PRD 2.3 示例）', () => {
    // 60 张达标卡 + 10 张新卡；60 张里转化率最低的 10 张应被挤到第 61–70 名
    const operatorOrdered = Array.from({ length: 70 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>();
    for (let i = 0; i < 60; i += 1) engagement.set(`c${i}`, mature(60 - i));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: 0,
      seed: 3,
    });

    expect(ordered).toHaveLength(70);
    const tailIds = ordered.slice(60).map((c) => c.id);
    // 末尾十名全部来自原有的低转化率卡，而不是新卡
    tailIds.forEach((id) => {
      const index = Number(id.slice(1));
      expect(index).toBeLessThan(60);
    });
  });

  it('同一种子结果稳定，不同种子会重新洗牌', () => {
    const operatorOrdered = Array.from({ length: 80 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>();
    for (let i = 0; i < 70; i += 1) engagement.set(`c${i}`, mature(80 - i));

    const build = (seed: number) =>
      buildRecommendedOrder({ operatorOrdered, engagement, fixedCount: FIXED_COUNT, seed })
        .map((c) => c.id)
        .join(',');

    expect(build(11)).toBe(build(11));
    expect(build(11)).not.toBe(build(12));
  });

  it('没有聊天数据的角色按新卡处理', () => {
    const operatorOrdered = Array.from({ length: 40 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>();
    for (let i = 0; i < 39; i += 1) engagement.set(`c${i}`, mature(50));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 5,
    });

    const rank = ordered.findIndex((c) => c.id === 'c39') + 1;
    expect(rank).toBeGreaterThanOrEqual(LOBBY_COLD_START_SLOT_FIRST);
  });

  it('列表整体不丢卡也不重复', () => {
    const operatorOrdered = Array.from({ length: 55 }, (_, i) => card(`c${i}`));
    const engagement = new Map<string, CharacterEngagement>();
    for (let i = 0; i < 30; i += 1) engagement.set(`c${i}`, mature(30 - i));

    const ordered = buildRecommendedOrder({
      operatorOrdered,
      engagement,
      fixedCount: FIXED_COUNT,
      seed: 9,
    });

    expect(ordered).toHaveLength(55);
    expect(new Set(ordered.map((c) => c.id)).size).toBe(55);
  });
});

describe('dailyShuffleSeed', () => {
  it('同一天内种子相同，跨天变化', () => {
    const morning = new Date('2026-07-28T01:00:00Z');
    const evening = new Date('2026-07-28T23:00:00Z');
    const nextDay = new Date('2026-07-29T01:00:00Z');

    expect(dailyShuffleSeed(morning)).toBe(dailyShuffleSeed(evening));
    expect(dailyShuffleSeed(nextDay)).not.toBe(dailyShuffleSeed(morning));
  });
});
