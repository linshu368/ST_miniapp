/**
 * backend / features / lobby / ranking-score.ts
 *
 * 首页「推荐」排序 v3 的统计层：把每张卡的原始量算成 0–100 的排序分。
 *
 * 刻意做成零 IO 的纯函数——窗口聚合、会话切分这些交给 SQL（ranking-stats.ts），
 * 贝叶斯收缩、百分位归一化、加权求和这些留在这里，才测得动边界条件
 * （样本只有一张卡、没有成熟卡、分母为 0 …），不用起数据库。
 *
 * 口径见 docs/ST_remove-M5-前端实施计划.md §B0。
 *
 * 各项参数（窗口、cap、权重、门槛、分位点）来自运营台，由调用方读 runtime_config
 * 后注入（见 ranking-params.ts）。这里刻意不自己去读配置：纯函数才测得动边界条件。
 */

import type { LobbyRankingParams } from '@miniapp/shared';

/** SQL 侧算出的每卡原始量 */
export interface RawCardStats {
  characterId: string;
  /** n_c：窗口内与该卡有过至少一轮的去重用户数 */
  sampleSize: number;
  /** D30_c = AVG(LEAST(turns, 30)) / 30，取值 [0, 1]；无样本时为 null */
  d30Raw: number | null;
  /** k_c：窗口内首次会话已结束满 48 小时的新客数 */
  returnSampleSize: number;
  /** R48_c = 48 小时内回访的新客 / k_c；k_c = 0 时为 null */
  r48Raw: number | null;
}

export interface RankingScore extends RawCardStats {
  /** 收缩后的 D30，排序标尺用的是它 */
  d30Shrunk: number;
  /** 0–100，保留两位小数 */
  score: number;
}

/** 归一化标尺。样本不足以形成区分度时为 null，此时一律取中性值 */
interface Scale {
  p10: number;
  p90: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 线性插值百分位（与 numpy 默认的 'linear' 一致）。
 * 入参必须已升序排列——调用方只排一次，别在这里重复排。
 */
export function percentile(sortedAsc: readonly number[], fraction: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;

  const position = clamp(fraction, 0, 1) * (sortedAsc.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sortedAsc[lower] as number;
  if (lower === upper) return low;

  const high = sortedAsc[upper] as number;
  return low + (high - low) * (position - lower);
}

function buildScale(samples: readonly number[], params: LobbyRankingParams): Scale | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p10: percentile(sorted, params.norm_percentile_low),
    p90: percentile(sorted, params.norm_percentile_high),
  };
}

/**
 * 按标尺归一到 [0, 1]。
 * P90 <= P10 说明这批卡在该指标上没有区分度（样本太少或全部同值），
 * 此时退化为中性值——硬算会因为除零把所有卡都推到极端。
 */
export function normalizeByScale(value: number, scale: Scale | null, neutralNorm: number): number {
  if (!scale) return neutralNorm;
  const span = scale.p90 - scale.p10;
  if (!(span > 0)) return neutralNorm;
  return clamp((value - scale.p10) / span, 0, 1);
}

/**
 * 全局先验 μ_D：成熟卡按样本量加权的 D30 均值。
 * 一张卡的样本越多，它对「平均一张卡应该有多深」的贡献越大。
 */
function resolvePriorMean(rows: readonly RawCardStats[], params: LobbyRankingParams): number {
  const weightedMean = (candidates: readonly RawCardStats[]): number | null => {
    let weightSum = 0;
    let valueSum = 0;
    for (const row of candidates) {
      if (row.d30Raw === null || row.sampleSize <= 0) continue;
      weightSum += row.sampleSize;
      valueSum += row.sampleSize * row.d30Raw;
    }
    return weightSum > 0 ? valueSum / weightSum : null;
  };

  // 冷启动期可能一张成熟卡都没有，退到「所有有样本的卡」，仍为空才用中性值。
  return (
    weightedMean(rows.filter((row) => row.sampleSize >= params.min_users)) ??
    weightedMean(rows) ??
    params.neutral_norm
  );
}

function shrinkD30(row: RawCardStats, priorMean: number, params: LobbyRankingParams): number {
  const observed = row.d30Raw ?? 0;
  const weight = Math.max(row.sampleSize, 0);
  const prior = params.d30_prior_weight;
  // 收缩关闭（m_D = 0）且这张卡一个样本都没有时，分母会是 0。
  // 这种卡没有任何可采信的观测，直接取先验。
  if (weight + prior <= 0) return priorMean;
  return (weight * observed + prior * priorMean) / (weight + prior);
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 算出每张卡的排序分。
 *
 * 两条标尺分别取样：D30 用所有成熟卡的收缩值，R48 用所有分母达标卡的原始值。
 * 分开取样是因为两个指标的达标门槛不同——一张卡可以样本够深、但新客还没满 48 小时。
 *
 * 未达 params.min_users 的卡也会算出分数并返回（便于观察），
 * 只是排序时由 buildRecommendedOrder 把它们划进冷启动池，分数不参与比较。
 */
export function computeRankingScores(
  rows: readonly RawCardStats[],
  params: LobbyRankingParams
): RankingScore[] {
  const priorMean = resolvePriorMean(rows, params);
  const neutral = params.neutral_norm;

  const shrunkByCard = new Map<string, number>();
  for (const row of rows) {
    shrunkByCard.set(row.characterId, shrinkD30(row, priorMean, params));
  }

  const d30Scale = buildScale(
    rows
      .filter((row) => row.sampleSize >= params.min_users)
      .map((row) => shrunkByCard.get(row.characterId) as number),
    params
  );
  const r48Scale = buildScale(
    rows
      .filter((row) => row.returnSampleSize >= params.r48_full_trust_sample && row.r48Raw !== null)
      .map((row) => row.r48Raw as number),
    params
  );

  return rows.map((row) => {
    const d30Shrunk = shrunkByCard.get(row.characterId) as number;

    // 分母不足时不能直接采信实测回访率：一个人回访就是 100%。
    // 用线性过渡带把它按样本量往中性值拉，样本攒够 X_R 个才完全采信。
    const trust = clamp(row.returnSampleSize / params.r48_full_trust_sample, 0, 1);
    const normR48 = row.r48Raw === null ? neutral : normalizeByScale(row.r48Raw, r48Scale, neutral);
    const effectiveR48 = trust * normR48 + (1 - trust) * neutral;

    const score =
      100 *
      (params.d30_weight * normalizeByScale(d30Shrunk, d30Scale, neutral) +
        params.r48_weight * effectiveR48);

    return { ...row, d30Shrunk, score: roundToCents(score) };
  });
}
