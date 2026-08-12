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
 */

/** 统计窗口宽度。窗口内 = created_at >= now() - 80d */
export const LOBBY_RANKING_WINDOW_DAYS = 80;

/**
 * D30 的硬阈值：窗口内去重用户数低于它的卡不进主池，改走冷启动随机插入。
 * 也是「成熟卡」的定义——全局先验 μ_D 与 D30 标尺都只从这批卡取样。
 */
export const LOBBY_RANKING_MIN_SAMPLE = 20;

/** D30 贝叶斯收缩的先验权重（m_D）。与硬阈值同值：样本刚够进主池时，先验与实测各占一半 */
export const D30_PRIOR_WEIGHT = 20;

/** R48 的软阈值：分母达到它才完全采信实测值，之下按线性过渡带向中位回退 */
export const R48_FULL_TRUST_SAMPLE = 40;

/** 单轮对话深度的封顶值。超过 30 轮的部分不再加分，避免重度用户拉高整卡均值 */
export const D30_TURN_CAP = 30;

export const D30_WEIGHT = 0.75;
export const R48_WEIGHT = 0.25;

/** 无样本时的中性归一值。既不奖励也不惩罚，等价于「排在标尺正中间」 */
const NEUTRAL_NORM = 0.5;

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

function buildScale(samples: readonly number[]): Scale | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return { p10: percentile(sorted, 0.1), p90: percentile(sorted, 0.9) };
}

/**
 * 按标尺归一到 [0, 1]。
 * P90 <= P10 说明这批卡在该指标上没有区分度（样本太少或全部同值），
 * 此时退化为中性值——硬算会因为除零把所有卡都推到极端。
 */
export function normalizeByScale(value: number, scale: Scale | null): number {
  if (!scale) return NEUTRAL_NORM;
  const span = scale.p90 - scale.p10;
  if (!(span > 0)) return NEUTRAL_NORM;
  return clamp((value - scale.p10) / span, 0, 1);
}

/**
 * 全局先验 μ_D：成熟卡按样本量加权的 D30 均值。
 * 一张卡的样本越多，它对「平均一张卡应该有多深」的贡献越大。
 */
function resolvePriorMean(rows: readonly RawCardStats[]): number {
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
    weightedMean(rows.filter((row) => row.sampleSize >= LOBBY_RANKING_MIN_SAMPLE)) ??
    weightedMean(rows) ??
    NEUTRAL_NORM
  );
}

function shrinkD30(row: RawCardStats, priorMean: number): number {
  const observed = row.d30Raw ?? 0;
  const weight = Math.max(row.sampleSize, 0);
  return (weight * observed + D30_PRIOR_WEIGHT * priorMean) / (weight + D30_PRIOR_WEIGHT);
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
 * 未达 LOBBY_RANKING_MIN_SAMPLE 的卡也会算出分数并返回（便于观察），
 * 只是排序时由 buildRecommendedOrder 把它们划进冷启动池，分数不参与比较。
 */
export function computeRankingScores(rows: readonly RawCardStats[]): RankingScore[] {
  const priorMean = resolvePriorMean(rows);

  const shrunkByCard = new Map<string, number>();
  for (const row of rows) {
    shrunkByCard.set(row.characterId, shrinkD30(row, priorMean));
  }

  const d30Scale = buildScale(
    rows
      .filter((row) => row.sampleSize >= LOBBY_RANKING_MIN_SAMPLE)
      .map((row) => shrunkByCard.get(row.characterId) as number)
  );
  const r48Scale = buildScale(
    rows
      .filter((row) => row.returnSampleSize >= R48_FULL_TRUST_SAMPLE && row.r48Raw !== null)
      .map((row) => row.r48Raw as number)
  );

  return rows.map((row) => {
    const d30Shrunk = shrunkByCard.get(row.characterId) as number;

    // 分母不足时不能直接采信实测回访率：一个人回访就是 100%。
    // 用线性过渡带把它按样本量往中性值拉，样本攒够 40 个才完全采信。
    const trust = clamp(row.returnSampleSize / R48_FULL_TRUST_SAMPLE, 0, 1);
    const normR48 = row.r48Raw === null ? NEUTRAL_NORM : normalizeByScale(row.r48Raw, r48Scale);
    const effectiveR48 = trust * normR48 + (1 - trust) * NEUTRAL_NORM;

    const score =
      100 * (D30_WEIGHT * normalizeByScale(d30Shrunk, d30Scale) + R48_WEIGHT * effectiveR48);

    return { ...row, d30Shrunk, score: roundToCents(score) };
  });
}
