// 首页「推荐」页排序 v3：运营固定位 + 剩余全量按排序分降序 + 样本不足的冷启动卡随机插入中段。
//
// 与 v2 的两处根本差别：
//   1. 冷启动卡的位置每次请求都重排，不再按自然日固定。大厅取数两跳都是 no-store，
//      前端 Next 路由代理带 cache: 'no-store'，所以后端不设缓存就真的每次生效。
//   2. 固定位从「sort_order 的前八」改成运营在平台上点选的一批 id（093 起）。
//      v3 初版把固定位整个删了，实践下来运营需要主推位，于是加回来——但只占前面几个位置，
//      第九张起仍然完全按分数跑，两套机制不再互相覆盖。
//      固定位为空时行为与 v3 初版逐字一致。

import type { CardScore } from './ranking-stats.js';

/** 冷启动卡的插入区间，按主池长度的比例取，闭区间 */
export const LOBBY_COLD_START_BAND_START = 0.3;
export const LOBBY_COLD_START_BAND_END = 0.6;

/** mulberry32：种子相同则序列相同，保证单测可复现 */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  return items
    .map((item) => ({ item, key: rng() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.item);
}

interface Partitioned<T> {
  /** 样本达标，按分数降序排好 */
  main: T[];
  /** 样本不足，等待随机插入 */
  cold: T[];
}

/**
 * 分池并给主池排序。
 * 同分回落到运营顺序：没有表现差异时列表不该来回跳动。
 */
function partition<T extends { id: string }>(
  operatorOrdered: readonly T[],
  scores: ReadonlyMap<string, CardScore>,
  minSample: number
): Partitioned<T> {
  const mature: Array<{ item: T; score: number; operatorIndex: number }> = [];
  const cold: T[] = [];

  operatorOrdered.forEach((item, operatorIndex) => {
    const stat = scores.get(item.id);
    if (stat && stat.sampleSize >= minSample) {
      mature.push({ item, score: stat.score, operatorIndex });
    } else {
      cold.push(item);
    }
  });

  mature.sort((a, b) =>
    b.score === a.score ? a.operatorIndex - b.operatorIndex : b.score - a.score
  );

  return { main: mature.map((entry) => entry.item), cold };
}

/**
 * 把配置里的固定位 id 解成实到的卡，并返回剩下的候选池。
 *
 * 按配置顺序取，而不是按运营顺序：运营在平台上排的就是「第一张放谁」。
 * 配了但不在候选池里（下架、归档、删卡）就跳过——宁可少一个固定位，
 * 也不能因为一张失效的 id 让首页缺位或报错。
 */
function splitPinned<T extends { id: string }>(
  operatorOrdered: readonly T[],
  pinnedIds: readonly string[]
): { pinned: T[]; rest: T[] } {
  if (pinnedIds.length === 0) return { pinned: [], rest: [...operatorOrdered] };

  const byId = new Map(operatorOrdered.map((item) => [item.id, item]));
  const pinned: T[] = [];
  const taken = new Set<string>();

  for (const id of pinnedIds) {
    const item = byId.get(id);
    // taken 去重：配置侧已经拦了重复，这里兜住历史脏数据，否则同一张卡会在列表里出现两次
    if (!item || taken.has(id)) continue;
    taken.add(id);
    pinned.push(item);
  }

  return { pinned, rest: operatorOrdered.filter((item) => !taken.has(item.id)) };
}

/**
 * 只把固定位提到最前面，其余保持运营顺序。
 * 排序分快照拿不到时用它：运营点的主推位与打分无关，不该被刷新 job 的状态连带拖掉。
 */
export function applyPinnedOnly<T extends { id: string }>(
  operatorOrdered: readonly T[],
  pinnedIds: readonly string[]
): T[] {
  const { pinned, rest } = splitPinned(operatorOrdered, pinnedIds);
  return [...pinned, ...rest];
}

/**
 * 金框位对应的角色 id。
 *
 * 固定位天然在最前面，所以先全部收进来，剩下的名额再按主池分数补齐。
 * 补齐用主池的前 N 而不是最终列表的前 N 个位置——主池顺序是确定的，
 * 这样大厅列表与角色详情页对同一张卡的判断不会打架。
 * buildRecommendedOrder 会保证冷启动卡插不进这段头部，两种口径因此始终一致。
 */
export function resolveFeaturedIds<T extends { id: string }>(
  operatorOrdered: readonly T[],
  scores: ReadonlyMap<string, CardScore>,
  count: number,
  minSample: number,
  pinnedIds: readonly string[] = []
): Set<string> {
  const limit = Math.max(0, count);
  const { pinned, rest } = splitPinned(operatorOrdered, pinnedIds);
  const featured = new Set(pinned.slice(0, limit).map((item) => item.id));
  if (featured.size >= limit) return featured;

  const { main } = partition(rest, scores, minSample);
  for (const item of main) {
    if (featured.size >= limit) break;
    featured.add(item.id);
  }
  return featured;
}

export interface BuildRecommendedOrderInput<T> {
  /** 运营配置顺序（sort_order 升序），同分时的次级顺序以它为准 */
  operatorOrdered: readonly T[];
  scores: ReadonlyMap<string, CardScore>;
  /**
   * 主池硬门槛（X_D）。由调用方从排序分快照里带过来，不在这里读配置——
   * 分池门槛必须和这批分数是同一版参数算出来的。
   */
  minSample: number;
  /**
   * 冷启动卡不得插入的头部长度，即金框区。
   * 主池很短时 30% 会落进前八，让随机卡拿到金框——挡住这种情况，
   * 也让 resolveFeaturedIds 的「主池前 N」与列表的「位置前 N」始终指同一批卡。
   *
   * 固定位已经占掉的名额会从这里扣除：固定位本身就挡在头部，不必重复保护。
   */
  protectedPrefix?: number;
  /**
   * 运营点选的固定位 id，按展示顺序。占据列表最前面几个位置，不参与分数排序。
   * 空数组时整个函数的行为与加入固定位之前逐字一致。
   */
  pinnedIds?: readonly string[];
  /** 省略则每次调用重新随机；单测传固定值以复现 */
  seed?: number;
}

/**
 * 排序规则：
 * 0. 运营固定位按配置顺序占据最前面几个位置，不参与后面任何一步；
 * 1. 剩余卡里样本达标（n_c ≥ minSample）的进主池，按 score 降序，同分回落运营顺序；
 * 2. 样本不足的（含全新卡）随机插入主池长度的 30%–60% 区间，彼此之间完全随机；
 * 3. 冷启动卡数量超过区间宽度时把窗口向后撑开，不挤占头部。
 */
export function buildRecommendedOrder<T extends { id: string }>(
  input: BuildRecommendedOrderInput<T>
): T[] {
  const { operatorOrdered, scores, minSample, protectedPrefix = 0, pinnedIds = [], seed } = input;

  const { pinned, rest } = splitPinned(operatorOrdered, pinnedIds);
  const { main, cold } = partition(rest, scores, minSample);
  const rng = createRng(seed ?? Math.floor(Math.random() * 0x1_0000_0000));
  const coldQueue = shuffle(cold, rng);

  if (main.length === 0) return [...pinned, ...coldQueue];
  if (coldQueue.length === 0) return [...pinned, ...main];

  // 固定位已经挡在头部，金框区剩下的名额才需要继续保护
  const remainingPrefix = Math.max(0, protectedPrefix - pinned.length);

  const firstSlot = Math.min(
    Math.max(remainingPrefix, Math.round(LOBBY_COLD_START_BAND_START * main.length)),
    main.length
  );
  const lastSlot = Math.round(LOBBY_COLD_START_BAND_END * main.length);

  // 槽位必须一次性选定：逐张插入会让先插入的冷卡被后插入的顶出区间。
  const windowSize = Math.max(lastSlot - firstSlot + 1, coldQueue.length);
  const candidates: number[] = [];
  for (let offset = 0; offset < windowSize; offset += 1) candidates.push(firstSlot + offset);
  const slots = new Set(shuffle(candidates, rng).slice(0, coldQueue.length));

  const ordered: T[] = [];
  let coldIndex = 0;
  let mainIndex = 0;
  const total = main.length + coldQueue.length;

  for (let position = 0; position < total; position += 1) {
    const coldTurn = slots.has(position) && coldIndex < coldQueue.length;
    if (coldTurn || mainIndex >= main.length) {
      const item = coldQueue[coldIndex];
      if (item !== undefined) {
        coldIndex += 1;
        ordered.push(item);
        continue;
      }
    }
    const mainItem = main[mainIndex];
    if (mainItem !== undefined) {
      mainIndex += 1;
      ordered.push(mainItem);
    }
  }

  // 槽位是相对「非固定位那一段」算的，所以固定位在这里拼，不参与上面的 position
  return [...pinned, ...ordered];
}
