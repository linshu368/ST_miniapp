/**
 * 记忆栏（右侧面板状态栏下面）的结构化记忆。
 *
 * 由独立模型在状态更新时追加，不再由正文模型输出。格式由我们内定，玩家只能看不能改。
 * **按事件记，不按轮次记**：剧情真的有进展才记一条，没进展就不动；聊 100 轮原地打转就是没有新记录。
 * 轮次只在内部用来标记「记到哪了」，不给玩家看。
 * 越久远越粗，整份封顶：近期事件满了，最早几件合并成历史档案；档案、里程碑超出上限的并进可改写的「前情概要」。
 */
import { z } from 'zod';

export const MEMORY_BAR_LIMITS = {
  /** 近期事件最多几件 */
  entries: 10,
  /** 每次更新最多新记几件事（没进展就是 0） */
  newEntriesPerUpdate: 2,
  /** 近期事件放不下时，最早的几件合并成一条历史档案 */
  archiveMergeCount: 5,
  /** 事件标题：提示词要求 / 校验上限 */
  entryTitleChars: 24,
  entryTitleMaxChars: 36,
  /** 事件其余各项：提示词要求 / 校验上限 */
  entryFieldChars: 40,
  entryFieldMaxChars: 60,
  archives: 6,
  archiveFieldChars: 50,
  archiveFieldMaxChars: 80,
  milestones: 20,
  /** 每次更新最多新增几条里程碑 */
  newMilestonesPerUpdate: 3,
  /** 里程碑放不下时，一次把最早的几条并进前情概要 */
  milestoneFoldCount: 5,
  milestoneChars: 30,
  milestoneMaxChars: 50,
  summaryChars: 400,
  summaryMaxChars: 520,
  timeMaxChars: 24,
  whoMaxChars: 16,
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

/** 一件近期的事：剧情有进展才记；轮次只在内部用（这件事是在哪几轮之间发生的），不给玩家看 */
export const MemoryBarEntrySchema = z.object({
  from_turn: turn,
  to_turn: turn,
  /** 故事里的时间，如「周四 深夜」 */
  time: text(L.timeMaxChars),
  /** 一句话说清发生了什么 */
  title: text(L.entryTitleMaxChars),
  /** 感情进展（没有写「无」） */
  feeling: text(L.entryFieldMaxChars),
  /** 做过什么（亲密/性行为，没有写「无」） */
  acts: text(L.entryFieldMaxChars),
  /** 留下的身体与情绪状态 */
  state: text(L.entryFieldMaxChars),
  /** 悬念与承诺（没有写「无」） */
  hooks: text(L.entryFieldMaxChars),
});

/** 一条历史档案：最早的几件近期事件合并而成，平时只读 */
export const MemoryBarArchiveSchema = z.object({
  from_turn: turn,
  to_turn: turn,
  time_range: text(L.timeMaxChars * 2),
  /** 感情线走向 */
  line: text(L.archiveFieldMaxChars),
  /** 亲密经历概述 */
  intimacy: text(L.archiveFieldMaxChars),
  /** 累计变化 */
  changes: text(L.archiveFieldMaxChars),
  /** 仍有效的悬念与承诺 */
  hooks: text(L.archiveFieldMaxChars),
});

/** 一条里程碑：关系与亲密经历里的关键节点，平时只增不减 */
export const MemoryBarMilestoneSchema = z.object({
  turn,
  time: text(L.timeMaxChars),
  /** 对象（角色名） */
  who: text(L.whoMaxChars),
  text: text(L.milestoneMaxChars),
});

export const MemoryBarStateSchema = z.object({
  version: z.literal(1),
  /** 记到第几轮：这一轮以前的对话已经记过（或判断过没进展而并进了下一件事）；新的记录从它之后看起 */
  covered_turn: z.number().int().min(0),
  /** 前情概要：被挤出上限的档案、里程碑并进来；可改写，封顶 */
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
