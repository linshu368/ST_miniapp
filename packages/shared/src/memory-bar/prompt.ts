/**
 * 记忆栏模型的提示词。和状态栏同时机、分开调用；只在上一份记忆上追加，不重写已有的历史。
 *
 * system = 运营平台的 memory_bar_prompt（记什么、怎么记、内容限制，运营可改）+ 系统固定的输出要求。
 *
 * 记忆栏是剧情记录（发生过什么），不是状态栏（现在是什么样）：不规定字段和格式，用自然的文字写。
 * 按剧情记，不按轮次记：有进展才写，没有就不写。人物多、世界观大时每条线都要写到。
 * 越近越详细、越远越简略：哪几段要压短、压到多短，由代码按档位算好放进本次任务。
 * 玩家可以写一段「对记忆的要求」（比如"着重记录好墨尘和我的关系"）：内容上一律优先照办，只有输出结构和字数上限不变。
 * 喂：角色卡名 + 玩家的要求 + 已有记忆（只读）+ 上一段记录之前的 2 轮（已记过，帮助接上）+ 之后的对话 + 本次任务。
 * 不喂正文模型的 system prompt。纯函数：调用方准备好数据，这里只拼文本。
 */
import { z } from 'zod';
import type { MemoryBarTasks } from './plan';
import { MEMORY_BAR_LIMITS, type MemoryBarState } from './schema';

/** 玩家对记忆的要求（每人每张卡一段） */
export const MEMORY_BAR_REQUEST_MAX_CHARS = 300;

const L = MEMORY_BAR_LIMITS;

export const MEMORY_BAR_PROMPT_WINDOW = {
  /** 上一段记录之前带几轮做衔接（标【已记过】） */
  contextTurns: 2,
  /** 最近这么多轮给完整回复，更早的截短 */
  fullTurns: 10,
  userChars: 500,
  replyChars: 4000,
  olderReplyChars: 800,
  /** 最多看这么多轮；再早的一直没进展，不用再看 */
  maxTurns: 40,
  legacyChars: 8000,
} as const;

/** 运营平台托管的记忆栏 prompt（角色定位、怎么记、内容上的限制都在里面，由运营维护）。 */
export const MEMORY_BAR_PROMPT_KEY = 'memory_bar_prompt';
export const MEMORY_BAR_PROMPT_MAX_CHARS = 12000;
export const MemoryBarPromptSchema = z
  .string()
  .trim()
  .min(1, '记忆栏 prompt 不能为空')
  .max(MEMORY_BAR_PROMPT_MAX_CHARS);

/** 系统固定的输出要求：字段和字数上限与 apply.ts 的校验一一对应，所以不放运营平台。 */
export const MEMORY_BAR_OUTPUT_RULES = `输出要求（系统固定）：只输出一个 JSON 对象，不加代码块、不加任何解释：
{"record": "", "milestones": [], "compress": {}, "summary": null}
- record：这次新增的剧情记录，不超过 ${L.tiers.near.chars} 字；没有进展写 ""。
- milestones：这次新出现的里程碑，一句话、不超过 ${L.milestoneChars} 字，最多 ${L.newMilestonesPerUpdate} 条；没有写 []；已有的不要重复写。
- compress：【本次任务】要求压短旧记录时，按编号写压短后的文字，比如 {"A": "……"}；否则写 {}。
- summary：只有【本次任务】要求改写前情概要时才写，不超过 ${L.summaryChars} 字；否则写 null。
整份记忆不超过 ${L.totalMaxChars} 字：哪几段要压短、压到多短，系统按远近算好写在【本次任务】里。`;

export interface MemoryBarPromptTurn {
  index: number;
  user: string;
  /** 回复正文（已去掉旧消息里的选项、记忆区等尾巴） */
  reply: string;
}

export interface MemoryBarPromptInput {
  /** 运营平台的 memory_bar_prompt（已校验） */
  systemPrompt: string;
  character: { name: string };
  state: MemoryBarState;
  tasks: MemoryBarTasks;
  /** 衔接轮次 + 要看的轮次（升序）；index >= tasks.fromTurn 的是这次要看的 */
  turns: MemoryBarPromptTurn[];
  /** 玩家对记忆的要求；没写为空 */
  playerRequest?: string | null;
  /** 第二次调用时附上第一次输出的问题 */
  retryIssues?: string[];
}

const clip = (value: string, max: number, keep: 'head' | 'tail' = 'head') => {
  const list = [...value.trim()];
  if (list.length <= max) return list.join('');
  return keep === 'tail' ? '……' + list.slice(-max).join('') : list.slice(0, max).join('') + '……';
};

/** 已有记忆的文字形式（喂模型用；不带轮次） */
export function memoryBarText(state: MemoryBarState): string {
  const parts: string[] = [];
  if (state.summary.trim()) parts.push(`前情概要：\n${state.summary.trim()}`);
  if (state.milestones.length)
    parts.push(`里程碑：\n${state.milestones.map((m) => `- ${m.text}`).join('\n')}`);
  if (state.records.length)
    parts.push(`剧情记录（从早到晚）：\n${state.records.map((r) => r.text).join('\n')}`);
  return parts.join('\n\n');
}

function dialogueBlock(turns: MemoryBarPromptTurn[], fromTurn: number): string {
  const w = MEMORY_BAR_PROMPT_WINDOW;
  const context = turns.filter((t) => t.index < fromTurn).slice(-w.contextTurns);
  const fresh = turns.filter((t) => t.index >= fromTurn);
  const kept = fresh.slice(-w.maxTurns);
  const dropped = fresh.length - kept.length;
  const fullFrom = kept.length - w.fullTurns;
  const lines: string[] = ['【对话】'];
  for (const t of context)
    lines.push(
      `【已记过】玩家：${clip(t.user, w.userChars)}\n【已记过】角色：${clip(t.reply, w.olderReplyChars, 'tail')}`
    );
  if (dropped > 0) lines.push(`（中间还有一段对话一直没记下什么，省略）`);
  kept.forEach((t, k) => {
    const replyMax = k >= fullFrom ? w.replyChars : w.olderReplyChars;
    lines.push(`玩家：${clip(t.user, w.userChars)}\n角色：${clip(t.reply, replyMax, 'tail')}`);
  });
  return lines.join('\n');
}

/** 记下新的一段后，前面的往远挪：压短、并进前情概要 */
function tidyLines(tasks: MemoryBarTasks, summary: string): string[] {
  const foldOld = [
    ...(tasks.fold?.records.map((r) => r.text) ?? []),
    ...(tasks.fold?.milestones.map((m) => `- ${m.text}`) ?? []),
  ];
  const foldChars =
    foldOld.reduce((n, line) => n + [...line].length, 0) + [...summary.trim()].length;
  if (!tasks.compress.length && !foldOld.length) return ['3. 不需要整理旧记录，compress 写 {}。'];
  const lines = [
    '3. 如果这次写了 record，前面的记录都往远挪一位，要按下面整理；record 为空就都不用做，compress 写 {}、summary 写 null。',
  ];
  if (tasks.compress.length)
    lines.push(
      '   把这几段压短，写进 compress（越远越简略，只留仍然重要的人和事）：',
      ...tasks.compress.map((t) => {
        const tier = L.tiers[t.to];
        // 写明原文字数：模型有了参照，压出来的长度更稳
        return `   ${t.key}（原文 ${[...t.record.text].length} 字，压成${tier.style}，不超过 ${tier.chars} 字）：${t.record.text}`;
      })
    );
  if (foldOld.length)
    lines.push(
      // 写明并入内容的总字数：和压短项一样，给模型一个参照，输出长度更稳
      `   改写前情概要（summary，并入内容共 ${foldChars} 字，压成一段不超过 ${L.summaryChars} 字，宁短勿长）：把原来的前情概要和下面这些并成一段，只留对现在仍然重要的事，不重要的丢掉：`,
      `   原来的前情概要（${[...summary.trim()].length} 字）：${summary.trim() || '（空）'}`,
      ...foldOld.map((line) => `   ${line}`)
    );
  return lines;
}

function taskBlock(tasks: MemoryBarTasks, summary: string, hasRequest: boolean): string {
  const lines = [
    '【本次任务】',
    '1. 看上一段记录之后（没标【已记过】的部分），剧情有没有真的往前走。有就写进 record，把每条线、每个有变化的人都写到；没有就写 ""——没进展很正常，不要硬写。',
    ...(hasRequest ? ['   全程优先照【玩家对记忆的要求】来记。'] : []),
    '2. milestones 按上面的里程碑标准写，不够格就写 []。',
    ...tidyLines(tasks, summary),
  ];
  const legacy = tasks.fold?.legacy;
  if (legacy)
    lines.push(
      `4. 不管有没有进展，都要写前情概要（summary，不超过 ${L.summaryChars} 字）：把这段对话以前的记忆区原文整理成一段（格式不同，只取内容；越早越粗，只留对现在仍然重要的事）：`,
      clip(legacy.text, MEMORY_BAR_PROMPT_WINDOW.legacyChars, 'tail')
    );
  return lines.join('\n');
}

export function buildMemoryBarPromptMessages(input: MemoryBarPromptInput): {
  system: string;
  user: string;
} {
  const known = memoryBarText(input.state);
  const request = clip(input.playerRequest ?? '', MEMORY_BAR_REQUEST_MAX_CHARS);
  const parts = [`【角色卡】${input.character.name}`];
  if (request) parts.push(`【玩家对记忆的要求】（优先级最高，内容上一律照办）\n${request}`);
  parts.push(
    `【已有记忆】（只读，不要复述或改写）\n${known || '还没有。'}`,
    dialogueBlock(input.turns, input.tasks.fromTurn),
    taskBlock(input.tasks, input.state.summary, Boolean(request))
  );
  if (input.retryIssues?.length)
    parts.push(
      `【上一次输出的问题】\n${input.retryIssues.map((issue) => `- ${issue}`).join('\n')}\n请改正后重新输出完整的 JSON。`
    );
  parts.push('请只输出 JSON。');
  return {
    system: `${input.systemPrompt.trim()}\n\n${MEMORY_BAR_OUTPUT_RULES}`,
    user: parts.join('\n\n'),
  };
}
