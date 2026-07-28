// 首页「推荐」页排序：运营固定前八 + 第九张起按聊天转化率 + 新卡冷启动随机插入中段。

/** 累计进入聊天人数低于该值的角色视为新卡，不参与前 30 名竞争 */
export const LOBBY_COLD_START_MIN_ENTERED_USERS = 10;
/** 新卡随机插入的名次区间，1 起算的闭区间 */
export const LOBBY_COLD_START_SLOT_FIRST = 31;
export const LOBBY_COLD_START_SLOT_LAST = 60;

export interface CharacterEngagement {
  /** 进入过该角色聊天的去重用户数（转化率分母） */
  enteredUsers: number;
  /** 与该角色聊天达到 5 轮及以上的去重用户数（转化率分子） */
  convertedUsers: number;
}

const EMPTY_ENGAGEMENT: CharacterEngagement = { enteredUsers: 0, convertedUsers: 0 };

export function conversionRate(engagement: CharacterEngagement): number {
  if (engagement.enteredUsers <= 0) return 0;
  return engagement.convertedUsers / engagement.enteredUsers;
}

/**
 * 新卡插入位置需要在同一天内保持一致：列表每次重新拉取都重排会让用户浏览时卡片跳动。
 * 以自然日作为种子桶，当天任意一次请求得到的顺序都相同。
 */
export function dailyShuffleSeed(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/** mulberry32：种子相同则序列相同，保证排序可复现 */
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

export interface BuildRecommendedOrderInput<T> {
  /** 运营配置顺序（sort_order 升序），推荐页前 N 张与同转化率次级顺序都以它为准 */
  operatorOrdered: readonly T[];
  engagement: ReadonlyMap<string, CharacterEngagement>;
  /** 运营固定位数量，即大厅金框前八 */
  fixedCount: number;
  seed: number;
}

/**
 * 排序规则（PRD 2.2 / 2.3）：
 * 1. 前 fixedCount 张沿用运营顺序，不参与动态排序；
 * 2. 其余角色中，进入聊天人数达标的按转化率从高到低，同转化率沿用运营顺序；
 * 3. 未达标的新卡不进前 30 名，统一随机插入第 31–60 名，彼此之间完全随机。
 */
export function buildRecommendedOrder<T extends { id: string }>(
  input: BuildRecommendedOrderInput<T>
): T[] {
  const { operatorOrdered, engagement, fixedCount, seed } = input;

  const fixed = operatorOrdered.slice(0, Math.max(0, fixedCount));
  const rest = operatorOrdered.slice(Math.max(0, fixedCount));

  const mature: Array<{ item: T; rate: number; operatorIndex: number }> = [];
  const cold: T[] = [];

  rest.forEach((item, index) => {
    const stats = engagement.get(item.id) ?? EMPTY_ENGAGEMENT;
    if (stats.enteredUsers >= LOBBY_COLD_START_MIN_ENTERED_USERS) {
      mature.push({ item, rate: conversionRate(stats), operatorIndex: index });
    } else {
      cold.push(item);
    }
  });

  // 同转化率时回落到运营顺序，避免没有表现差异时列表来回跳动。
  mature.sort((a, b) => (b.rate === a.rate ? a.operatorIndex - b.operatorIndex : b.rate - a.rate));

  const baseQueue: T[] = [...fixed, ...mature.map((entry) => entry.item)];
  const rng = createRng(seed);
  const coldQueue = shuffle(cold, rng);
  const total = baseQueue.length + coldQueue.length;

  // 槽位必须一次性选定：逐张插入会让先插入的新卡被后插入的顶出第 60 名。
  const firstSlot = LOBBY_COLD_START_SLOT_FIRST - 1;
  const lastSlot = LOBBY_COLD_START_SLOT_LAST - 1;
  const windowSize = Math.max(lastSlot - firstSlot + 1, coldQueue.length);
  const candidates: number[] = [];
  for (let offset = 0; offset < windowSize; offset += 1) candidates.push(firstSlot + offset);
  const slots = new Set(shuffle(candidates, rng).slice(0, coldQueue.length));

  const ordered: T[] = [];
  let coldIndex = 0;
  let baseIndex = 0;

  for (let position = 0; position < total; position += 1) {
    const coldTurn = slots.has(position) && coldIndex < coldQueue.length;
    if (coldTurn || baseIndex >= baseQueue.length) {
      const item = coldQueue[coldIndex];
      if (item !== undefined) {
        coldIndex += 1;
        ordered.push(item);
        continue;
      }
    }
    const baseItem = baseQueue[baseIndex];
    if (baseItem !== undefined) {
      baseIndex += 1;
      ordered.push(baseItem);
    }
  }

  return ordered;
}
