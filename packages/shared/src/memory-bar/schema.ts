/**
 * 记忆栏（右侧面板状态栏下面）：这段故事的剧情记录。
 *
 * 和状态栏分工：状态栏记「现在是什么样」（固定的项）；记忆栏记「发生过什么」，用自然的文字写，
 * 像连载小说的前情提要，不规定字段和格式。人物多、世界观大就把每条线都写到。剧情记录第一，好看其次。
 *
 * 详细程度按远近分档（每段记录按它往前数第几段定档，不按轮次）：
 * - 近：最新几段，完整叙述；
 * - 中：再往前几段，压成两三句话；
 * - 远：再往前，压成一句话（面板里收在「更早的记忆」）；
 * - 很远：并进一段可改写的前情概要，只留对现在仍然重要的事。
 * 里程碑一句话一条，放不下时最早的几条也并进前情概要。整份记忆封顶 4000 字，不随对话增长。
 * 轮次只在内部用来标记「记到哪了」，不给玩家看。
 */
import { z } from 'zod';

export const MEMORY_BAR_TIERS = ['near', 'mid', 'far'] as const;
export type MemoryBarTier = (typeof MEMORY_BAR_TIERS)[number];

export const MEMORY_BAR_LIMITS = {
  /** 整份记忆（前情概要 + 剧情记录 + 里程碑）最多多少字 */
  totalMaxChars: 4000,
  /** 每档几段、每段多长：chars 是提示词里的要求，maxChars 是校验上限 */
  tiers: {
    near: { label: '近', count: 4, chars: 300, maxChars: 360, style: '完整叙述' },
    mid: { label: '中', count: 6, chars: 100, maxChars: 120, style: '两三句话' },
    far: { label: '远', count: 12, chars: 35, maxChars: 45, style: '一句话' },
  },
  /** 很远：前情概要 */
  summaryChars: 380,
  summaryMaxChars: 450,
  milestones: 20,
  /** 每次最多新增几条里程碑（里程碑是少数关键节点，实测放开 3 条时几乎每次都写满） */
  newMilestonesPerUpdate: 1,
  /** 里程碑放不下时，一次把最早的几条并进前情概要 */
  milestoneFoldCount: 5,
  milestoneChars: 30,
  milestoneMaxChars: 35,
} as const;

const L = MEMORY_BAR_LIMITS;
const chars = (value: string) => [...value].length;

/** 剧情记录最多几段（近 + 中 + 远） */
export const MEMORY_BAR_MAX_RECORDS = MEMORY_BAR_TIERS.reduce((n, t) => n + L.tiers[t].count, 0);

/** 往前数第几段（最新一段是 0）该在哪一档；null = 已经很远，该并进前情概要 */
export function memoryBarTierAt(position: number): MemoryBarTier | null {
  let start = 0;
  for (const tier of MEMORY_BAR_TIERS) {
    start += L.tiers[tier].count;
    if (position < start) return tier;
  }
  return null;
}

export const memoryBarTierRank = (tier: MemoryBarTier) => MEMORY_BAR_TIERS.indexOf(tier);

const text = z.string().trim().min(1);
const turn = z.number().int().min(1).max(100_000);

/** 一段剧情记录：轮次只在内部用（这段记录覆盖到哪），不给玩家看 */
export const MemoryBarRecordSchema = z
  .object({
    from_turn: turn,
    to_turn: turn,
    tier: z.enum(MEMORY_BAR_TIERS),
    text,
  })
  .refine((r) => chars(r.text) <= L.tiers[r.tier].maxChars, {
    message: '这一档的记录太长',
  });

/** 一条里程碑：一句话 */
export const MemoryBarMilestoneSchema = z.object({
  turn,
  text: text.refine((value) => chars(value) <= L.milestoneMaxChars, {
    message: `里程碑不超过 ${L.milestoneMaxChars} 字`,
  }),
});

export type MemoryBarRecord = z.infer<typeof MemoryBarRecordSchema>;
export type MemoryBarMilestone = z.infer<typeof MemoryBarMilestoneSchema>;

export interface MemoryBarState {
  version: 1;
  /** 记到第几轮：这一轮以前的对话已经记过；新的记录从它之后看起 */
  covered_turn: number;
  /** 前情概要（很远）：可改写，封顶 */
  summary: string;
  milestones: MemoryBarMilestone[];
  /** 从早到晚；每段的档位由它往前数第几段决定 */
  records: MemoryBarRecord[];
}

/** 整份记忆的字数（面板上能看到的文字） */
export function memoryBarChars(state: MemoryBarState): number {
  return (
    chars(state.summary) +
    state.records.reduce((n, r) => n + chars(r.text), 0) +
    state.milestones.reduce((n, m) => n + chars(m.text), 0)
  );
}

export const MemoryBarStateSchema: z.ZodType<MemoryBarState> = z
  .object({
    version: z.literal(1),
    covered_turn: z.number().int().min(0),
    summary: z.string().refine((value) => chars(value) <= L.summaryMaxChars, {
      message: `前情概要不超过 ${L.summaryMaxChars} 字`,
    }),
    milestones: z.array(MemoryBarMilestoneSchema).max(L.milestones),
    records: z.array(MemoryBarRecordSchema).max(MEMORY_BAR_MAX_RECORDS),
  })
  .refine((s) => s.records.every((r, i) => memoryBarTierAt(s.records.length - 1 - i) === r.tier), {
    message: '剧情记录的档位和远近不符',
  })
  .refine((s) => memoryBarChars(s) <= L.totalMaxChars, {
    message: `整份记忆不超过 ${L.totalMaxChars} 字`,
  });

export const EMPTY_MEMORY_BAR: MemoryBarState = {
  version: 1,
  covered_turn: 0,
  summary: '',
  milestones: [],
  records: [],
};

export const isEmptyMemoryBar = (state: MemoryBarState) =>
  !state.summary && !state.milestones.length && !state.records.length;
