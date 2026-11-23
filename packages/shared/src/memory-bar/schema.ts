/**
 * 记忆栏（右侧面板状态栏下面）：这段故事的剧情记录。
 *
 * 和状态栏分工：状态栏记「现在是什么样」（固定的项）；记忆栏记「发生过什么」，用自然的文字写，
 * 像连载小说的前情提要，不规定字段和格式。人物多、世界观大就把每条线都写到。剧情记录第一，好看其次。
 *
 * 结构只为控制长度：
 * - 剧情记录：剧情有进展才追加一段文字；没进展就不动（按剧情记，不按轮次记）；
 * - 里程碑：一句话一条；
 * - 更早的剧情：最早几段记录压缩成一段；再早的并进可改写的前情概要。整份封顶，不随轮数膨胀。
 * 轮次只在内部用来标记「记到哪了」，不给玩家看。
 */
import { z } from 'zod';

export const MEMORY_BAR_LIMITS = {
  /** 剧情记录最多几段 */
  entries: 10,
  /** 每段：提示词要求 / 校验上限 */
  entryChars: 300,
  entryMaxChars: 450,
  /** 剧情记录满了，最早几段压缩成一段「更早的剧情」 */
  archiveMergeCount: 5,
  archives: 4,
  archiveChars: 400,
  archiveMaxChars: 550,
  milestones: 30,
  /** 每次最多新增几条里程碑 */
  newMilestonesPerUpdate: 4,
  /** 里程碑放不下时，一次把最早的几条并进前情概要 */
  milestoneFoldCount: 10,
  milestoneChars: 40,
  milestoneMaxChars: 70,
  summaryChars: 500,
  summaryMaxChars: 650,
} as const;

const L = MEMORY_BAR_LIMITS;
const chars = (value: string) => [...value].length;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => chars(value) <= max, { message: `不超过 ${max} 字` });
const turn = z.number().int().min(1).max(100_000);

/** 一段剧情记录：轮次只在内部用（这段记录覆盖到哪），不给玩家看 */
export const MemoryBarEntrySchema = z.object({
  from_turn: turn,
  to_turn: turn,
  text: text(L.entryMaxChars),
});

/** 更早的剧情：几段记录压缩成的一段 */
export const MemoryBarArchiveSchema = MemoryBarEntrySchema.extend({
  text: text(L.archiveMaxChars),
});

/** 一条里程碑：一句话 */
export const MemoryBarMilestoneSchema = z.object({ turn, text: text(L.milestoneMaxChars) });

export const MemoryBarStateSchema = z.object({
  version: z.literal(1),
  /** 记到第几轮：这一轮以前的对话已经记过；新的记录从它之后看起 */
  covered_turn: z.number().int().min(0),
  /** 前情概要：最久远的剧情，可改写，封顶 */
  summary: z.string().refine((value) => chars(value) <= L.summaryMaxChars, {
    message: `前情概要不超过 ${L.summaryMaxChars} 字`,
  }),
  archives: z.array(MemoryBarArchiveSchema).max(L.archives),
  milestones: z.array(MemoryBarMilestoneSchema).max(L.milestones),
  entries: z.array(MemoryBarEntrySchema).max(L.entries),
});

export type MemoryBarEntry = z.infer<typeof MemoryBarEntrySchema>;
export type MemoryBarArchive = z.infer<typeof MemoryBarArchiveSchema>;
export type MemoryBarMilestone = z.infer<typeof MemoryBarMilestoneSchema>;
export type MemoryBarState = z.infer<typeof MemoryBarStateSchema>;

export const EMPTY_MEMORY_BAR: MemoryBarState = {
  version: 1,
  covered_turn: 0,
  summary: '',
  archives: [],
  milestones: [],
  entries: [],
};

export const isEmptyMemoryBar = (state: MemoryBarState) =>
  !state.summary && !state.archives.length && !state.milestones.length && !state.entries.length;
