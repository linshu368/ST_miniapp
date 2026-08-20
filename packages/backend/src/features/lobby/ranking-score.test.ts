import { DEFAULT_LOBBY_RANKING_PARAMS, type LobbyRankingParams } from '@miniapp/shared';
import { describe, expect, it } from 'vitest';
import {
  computeRankingScores,
  normalizeByScale,
  percentile,
  type RawCardStats,
} from './ranking-score.js';

/** 参数搬到运营台后仍以内置默认值为基准断言，这样这些用例继续锁的是打分口径本身 */
const PARAMS = DEFAULT_LOBBY_RANKING_PARAMS;
const D30_PRIOR_WEIGHT = PARAMS.d30_prior_weight;
const LOBBY_RANKING_MIN_SAMPLE = PARAMS.min_users;
const R48_FULL_TRUST_SAMPLE = PARAMS.r48_full_trust_sample;

function card(overrides: Partial<RawCardStats> & { characterId: string }): RawCardStats {
  return {
    sampleSize: 0,
    d30Raw: null,
    returnSampleSize: 0,
    r48Raw: null,
    ...overrides,
  };
}

function withParams(overrides: Partial<LobbyRankingParams>): LobbyRankingParams {
  return { ...PARAMS, ...overrides };
}

function scoreOf(
  rows: readonly RawCardStats[],
  characterId: string,
  params: LobbyRankingParams = PARAMS
): number {
  const found = computeRankingScores(rows, params).find((row) => row.characterId === characterId);
  if (!found) throw new Error(`missing score for ${characterId}`);
  return found.score;
}

describe('percentile', () => {
  it('按线性插值取值，与 numpy 默认口径一致', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 0.1)).toBeCloseTo(1.4);
    expect(percentile(sorted, 0.9)).toBeCloseTo(4.6);
    expect(percentile(sorted, 0.5)).toBeCloseTo(3);
  });

  it('单样本时任何分位都是它自己', () => {
    expect(percentile([0.42], 0.1)).toBe(0.42);
    expect(percentile([0.42], 0.9)).toBe(0.42);
  });

  it('空样本返回 NaN，由调用方兜底成中性值', () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

describe('normalizeByScale', () => {
  it('落在 P10–P90 之间按比例映射，两端截断', () => {
    const scale = { p10: 0.2, p90: 0.6 };
    expect(normalizeByScale(0.4, scale, 0.5)).toBeCloseTo(0.5);
    expect(normalizeByScale(0.1, scale, 0.5)).toBe(0);
    expect(normalizeByScale(0.9, scale, 0.5)).toBe(1);
  });

  it('P90 <= P10 时退化为中性值，不做除零', () => {
    expect(normalizeByScale(0.9, { p10: 0.5, p90: 0.5 }, 0.5)).toBe(0.5);
    expect(normalizeByScale(0.9, { p10: 0.7, p90: 0.3 }, 0.5)).toBe(0.5);
  });

  it('没有标尺（无达标样本）时取中性值，中性值由参数给', () => {
    expect(normalizeByScale(0.9, null, 0.5)).toBe(0.5);
    expect(normalizeByScale(0.9, null, 0.3)).toBe(0.3);
  });
});

describe('computeRankingScores — 贝叶斯收缩', () => {
  it('先验取成熟卡按样本量加权的均值，收缩后向它靠拢', () => {
    // 两张等样本的成熟卡，D30 分别是 1 和 0 → μ_D = 0.5
    // 样本量与先验权重相等，所以收缩后各走一半：0.75 / 0.25
    const rows = [
      card({ characterId: 'high', sampleSize: D30_PRIOR_WEIGHT, d30Raw: 1 }),
      card({ characterId: 'low', sampleSize: D30_PRIOR_WEIGHT, d30Raw: 0 }),
    ];

    const scores = computeRankingScores(rows, PARAMS);
    expect(scores.find((s) => s.characterId === 'high')?.d30Shrunk).toBeCloseTo(0.75);
    expect(scores.find((s) => s.characterId === 'low')?.d30Shrunk).toBeCloseTo(0.25);
  });

  it('样本越多越接近实测值，越少越接近先验', () => {
    const rows = [
      card({ characterId: 'heavy', sampleSize: 380, d30Raw: 1 }),
      card({ characterId: 'thin', sampleSize: 20, d30Raw: 1 }),
      card({ characterId: 'anchor', sampleSize: 400, d30Raw: 0 }),
    ];

    const scores = computeRankingScores(rows, PARAMS);
    const heavy = scores.find((s) => s.characterId === 'heavy')?.d30Shrunk as number;
    const thin = scores.find((s) => s.characterId === 'thin')?.d30Shrunk as number;
    expect(heavy).toBeGreaterThan(thin);
  });

  it('一张成熟卡都没有时，先验退到所有有样本的卡', () => {
    const rows = [
      card({ characterId: 'a', sampleSize: 4, d30Raw: 1 }),
      card({ characterId: 'b', sampleSize: 4, d30Raw: 0 }),
    ];

    const scores = computeRankingScores(rows, PARAMS);
    // μ_D = 0.5；样本 4 远小于先验权重 20，两张卡都被拉到 0.5 附近
    expect(scores.find((s) => s.characterId === 'a')?.d30Shrunk).toBeCloseTo(0.5833, 3);
    expect(scores.find((s) => s.characterId === 'b')?.d30Shrunk).toBeCloseTo(0.4167, 3);
  });

  it('完全没有样本时不产生 NaN', () => {
    const rows = [card({ characterId: 'fresh' }), card({ characterId: 'fresh2' })];

    for (const row of computeRankingScores(rows, PARAMS)) {
      expect(Number.isFinite(row.d30Shrunk)).toBe(true);
      expect(Number.isFinite(row.score)).toBe(true);
    }
  });
});

describe('computeRankingScores — R48 过渡带', () => {
  const mature = { sampleSize: LOBBY_RANKING_MIN_SAMPLE, d30Raw: 0.5 };

  it('分母达标时完全采信实测回访率', () => {
    const rows = [
      card({ characterId: 'best', ...mature, returnSampleSize: 40, r48Raw: 0.9 }),
      card({ characterId: 'worst', ...mature, returnSampleSize: 40, r48Raw: 0.1 }),
    ];

    // 两张卡 D30 相同 → norm(D30) 都是中性 0.5，分差只来自 R48
    // R48 一个被截到 1、一个被截到 0，权重 0.25 → 分差正好 25
    expect(scoreOf(rows, 'best') - scoreOf(rows, 'worst')).toBeCloseTo(25);
  });

  it('分母只有一半时，实测值与中性值各占一半', () => {
    const rows = [
      card({ characterId: 'best', ...mature, returnSampleSize: 40, r48Raw: 0.9 }),
      card({ characterId: 'worst', ...mature, returnSampleSize: 40, r48Raw: 0.1 }),
      card({
        characterId: 'thin',
        ...mature,
        returnSampleSize: R48_FULL_TRUST_SAMPLE / 2,
        r48Raw: 0.9,
      }),
    ];

    // norm(R48) = 1，信任度 0.5 → 生效值 0.5×1 + 0.5×0.5 = 0.75
    // score = 100 × (0.75×0.5 + 0.25×0.75)
    expect(scoreOf(rows, 'thin')).toBeCloseTo(56.25);
  });

  it('没有回访样本时 R48 完全退回中性，不惩罚也不奖励', () => {
    const rows = [
      card({ characterId: 'best', ...mature, returnSampleSize: 40, r48Raw: 0.9 }),
      card({ characterId: 'worst', ...mature, returnSampleSize: 40, r48Raw: 0.1 }),
      card({ characterId: 'none', ...mature, returnSampleSize: 0, r48Raw: null }),
    ];

    // score = 100 × (0.75×0.5 + 0.25×0.5) = 50
    expect(scoreOf(rows, 'none')).toBeCloseTo(50);
  });
});

describe('computeRankingScores — 整体', () => {
  it('只有一张卡时两条标尺都无区分度，落在正中间 50 分', () => {
    const rows = [
      card({
        characterId: 'only',
        sampleSize: 100,
        d30Raw: 0.9,
        returnSampleSize: 80,
        r48Raw: 0.9,
      }),
    ];

    expect(scoreOf(rows, 'only')).toBeCloseTo(50);
  });

  it('未达样本阈值的冷启动卡也照常返回分数，供观察用', () => {
    const rows = [
      card({ characterId: 'mature', sampleSize: 100, d30Raw: 0.8 }),
      card({ characterId: 'cold', sampleSize: 3, d30Raw: 1 }),
    ];

    const scores = computeRankingScores(rows, PARAMS);
    expect(scores).toHaveLength(2);
    expect(scores.every((row) => Number.isFinite(row.score))).toBe(true);
  });

  it('分数落在 0–100 且保留两位小数', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      card({
        characterId: `c${i}`,
        sampleSize: 20 + i * 7,
        d30Raw: (i % 11) / 10,
        returnSampleSize: i * 3,
        r48Raw: (i % 7) / 10,
      })
    );

    for (const row of computeRankingScores(rows, PARAMS)) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
      expect(row.score).toBe(Math.round(row.score * 100) / 100);
    }
  });

  it('原始量原样带出，便于事后复核某张卡为什么是这个分', () => {
    const rows = [
      card({ characterId: 'a', sampleSize: 42, d30Raw: 0.6, returnSampleSize: 51, r48Raw: 0.3 }),
    ];

    expect(computeRankingScores(rows, PARAMS)[0]).toMatchObject({
      characterId: 'a',
      sampleSize: 42,
      d30Raw: 0.6,
      returnSampleSize: 51,
      r48Raw: 0.3,
    });
  });
});

// 平台化的意义就在这一组：运营在运营台改了值，分数必须真的跟着变。
// 只要有一处参数没接上（还在读旧常量），下面就会有用例挂掉。
describe('computeRankingScores — 运营参数确实生效', () => {
  it('权重换成全押 D30 后，R48 的差异不再影响分数', () => {
    const mature = { sampleSize: 100, d30Raw: 0.5 };
    const rows = [
      card({ characterId: 'best', ...mature, returnSampleSize: 40, r48Raw: 0.9 }),
      card({ characterId: 'worst', ...mature, returnSampleSize: 40, r48Raw: 0.1 }),
    ];

    expect(scoreOf(rows, 'best') - scoreOf(rows, 'worst')).toBeCloseTo(25);

    const d30Only = withParams({ d30_weight: 1, r48_weight: 0 });
    expect(scoreOf(rows, 'best', d30Only)).toBeCloseTo(scoreOf(rows, 'worst', d30Only));
  });

  it('收缩强度归零后，小样本卡的实测值不再被拉向先验', () => {
    const rows = [
      card({ characterId: 'thin', sampleSize: 2, d30Raw: 1 }),
      card({ characterId: 'anchor', sampleSize: 400, d30Raw: 0 }),
    ];

    const shrunk = computeRankingScores(rows, PARAMS).find((row) => row.characterId === 'thin');
    expect(shrunk?.d30Shrunk).toBeLessThan(0.2);

    const noShrink = computeRankingScores(rows, withParams({ d30_prior_weight: 0 })).find(
      (row) => row.characterId === 'thin'
    );
    expect(noShrink?.d30Shrunk).toBeCloseTo(1);
  });

  it('抬高主池门槛会换掉 D30 标尺的取样人群，分数随之变化', () => {
    const rows = [
      card({ characterId: 'a', sampleSize: 30, d30Raw: 0.9 }),
      card({ characterId: 'b', sampleSize: 30, d30Raw: 0.1 }),
      card({ characterId: 'c', sampleSize: 500, d30Raw: 0.5 }),
    ];

    const before = scoreOf(rows, 'a');
    // 门槛抬到 100 后只剩 c 一张成熟卡，标尺失去区分度，所有卡落到中性分
    const after = scoreOf(rows, 'a', withParams({ min_users: 100 }));
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(50);
  });

  it('R48 软门槛决定过渡带斜率', () => {
    const mature = { sampleSize: 100, d30Raw: 0.5 };
    const rows = [
      card({ characterId: 'best', ...mature, returnSampleSize: 40, r48Raw: 0.9 }),
      card({ characterId: 'worst', ...mature, returnSampleSize: 40, r48Raw: 0.1 }),
      card({ characterId: 'thin', ...mature, returnSampleSize: 20, r48Raw: 0.9 }),
    ];

    // 默认门槛 40：信任度 0.5 → 100 × (0.75×0.5 + 0.25×0.75) = 56.25
    expect(scoreOf(rows, 'thin')).toBeCloseTo(56.25);
    // 门槛降到 20：这张卡的分母已达标，完全采信 → 100 × (0.75×0.5 + 0.25×1) = 62.5
    expect(scoreOf(rows, 'thin', withParams({ r48_full_trust_sample: 20 }))).toBeCloseTo(62.5);
  });

  it('中性值改掉后，无样本卡落到新的中性分', () => {
    const rows = [card({ characterId: 'only', sampleSize: 100, d30Raw: 0.5 })];

    expect(scoreOf(rows, 'only')).toBeCloseTo(50);
    expect(scoreOf(rows, 'only', withParams({ neutral_norm: 0.2 }))).toBeCloseTo(20);
  });

  it('归一化分位点收窄后标尺变陡，更多卡被截到两端', () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      card({ characterId: `c${i}`, sampleSize: 1000, d30Raw: i / 10 })
    );
    const countClamped = (params: LobbyRankingParams) =>
      computeRankingScores(rows, params).filter((row) => row.score === 0 || row.score === 100)
        .length;

    const wide = countClamped(withParams({ d30_weight: 1, r48_weight: 0 }));
    const narrow = countClamped(
      withParams({
        d30_weight: 1,
        r48_weight: 0,
        norm_percentile_low: 0.3,
        norm_percentile_high: 0.7,
      })
    );
    expect(narrow).toBeGreaterThan(wide);
  });
});
