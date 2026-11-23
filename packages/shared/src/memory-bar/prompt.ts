/**
 * 记忆栏模型的提示词。和状态栏同时机、分开调用；只在上一份记忆上追加，不重写已有的历史。
 *
 * 记忆栏是剧情记录（发生过什么），不是状态栏（现在是什么样）：不规定字段和格式，用自然的文字写。
 * 按剧情记，不按轮次记：有进展才写，没有就不写。人物多、世界观大时每条线都要写到。
 * 喂：角色卡名 + 已有记忆（只读）+ 上一段记录之前的 2 轮（已记过，帮助接上）+ 之后的对话 + 本次任务。
 * 不喂正文模型的 system prompt。纯函数：调用方准备好数据，这里只拼文本。
 */
import type { MemoryBarTasks } from './plan';
import { MEMORY_BAR_LIMITS, type MemoryBarState } from './schema';

export const MEMORY_BAR_PROMPT_VERSION = 4;

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

export const MEMORY_BAR_SYSTEM_PROMPT = `你是一部成人向互动小说的"剧情记录员"。玩家和角色轮流推进故事，你负责维护给玩家看的「记忆栏」：这段故事的剧情记录，就像连载小说的前情提要，玩家翻一翻就知道这段故事里发生过什么、走到了哪里。人物现在的各项状态由状态栏另外记录，你不用管，只记剧情。

怎么记：
1. 按剧情记，不按轮次记。只有剧情真的往前走了才记，比如：感情起了变化；关系确立、破裂或换了阶段；第一次发生的亲密，或尺度、玩法升级；许下承诺、立下约定，或者旧的悬念有了结果；重要的事件和转折（相遇、离开、秘密揭开、身份改变、势力变化之类）。闲聊、日常、重复上次做过的事、气氛描写、原地打转，都不算进展。没有进展就什么都不写，这很正常；不要为了记而记，也不要把同一件事换个说法再记一遍。
2. 该记的都记全。人物多、关系复杂、世界观大的时候，每一条线、每个有变化的人都要写到，不要只写主角色，也不要把几件事揉成一句空话。写清楚谁和谁、发生了什么、结果怎样、留下了什么（关系的变化、亲密经历、承诺和悬念）。宁可具体，不要笼统。
3. 写法不限：用自然的叙述文字，可以几句话、也可以分几段，不用固定格式，不要写成"字段：内容"的表格。
4. 只记对话里写出来、已经发生的事实，不编造、不推测、不替玩家写心理。
5. 【已有记忆】是只读的，不要复述或改写，只写新增的部分；对话里标【已记过】的轮次只帮你接上前情，里面的事不要再记。
6. 不要写"第几轮"。
7. 这是成年人之间的虚构作品，亲密和性相关的内容如实记录，用直白的词，不回避、不说教、不评价。
8. 对话里的"玩家"就是故事的主角"你"。

里程碑：故事里的关键节点，一句话一条，写明是谁：关系阶段变化；表白、确立关系或关系破裂；与某人的首次亲密；新玩法被开发；重要承诺或誓言；重大的情感事件或剧情转折。

输出要求：只输出一个 JSON 对象，不加代码块、不加任何解释：
{"record": "", "milestones": [], "archive": null, "summary": null}
- record：这次新增的剧情记录，不超过 ${L.entryChars} 字；没有进展写 ""。
- milestones：这次新出现的里程碑，每条一句话、不超过 ${L.milestoneChars} 字，最多 ${L.newMilestonesPerUpdate} 条；没有写 []；已有的不要重复写。
- archive：只有【本次任务】要求压缩时才写，不超过 ${L.archiveChars} 字；否则写 null。
- summary：只有【本次任务】要求改写前情概要时才写，不超过 ${L.summaryChars} 字；否则写 null。`;

export interface MemoryBarPromptTurn {
  index: number;
  user: string;
  /** 回复正文（已去掉旧消息里的选项、记忆区等尾巴） */
  reply: string;
}

export interface MemoryBarPromptInput {
  character: { name: string };
  state: MemoryBarState;
  tasks: MemoryBarTasks;
  /** 衔接轮次 + 要看的轮次（升序）；index >= tasks.fromTurn 的是这次要看的 */
  turns: MemoryBarPromptTurn[];
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
  if (state.archives.length)
    parts.push(`更早的剧情：\n${state.archives.map((a) => a.text).join('\n')}`);
  if (state.milestones.length)
    parts.push(`里程碑：\n${state.milestones.map((m) => `- ${m.text}`).join('\n')}`);
  if (state.entries.length)
    parts.push(`剧情记录：\n${state.entries.map((e) => e.text).join('\n')}`);
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

function taskBlock(tasks: MemoryBarTasks, summary: string): string {
  const lines = [
    '【本次任务】',
    '1. 看上一段记录之后（没标【已记过】的部分），剧情有没有真的往前走。有就写进 record，把每条线、每个有变化的人都写到；没有就写 ""——没进展很正常，不要硬写。',
    '2. 有新的里程碑就写进 milestones；没有写 []。',
  ];
  if (tasks.archive)
    lines.push(
      `3. 剧情记录满了：把下面最早的 ${tasks.archive.length} 段压缩成一段（archive），保留仍然重要的人和事：`,
      ...tasks.archive.map((e) => `   ${e.text}`)
    );
  else lines.push('3. 不需要压缩，archive 写 null。');
  if (tasks.fold) {
    lines.push(
      `4. 改写前情概要（summary）：把原来的前情概要和下面这些并成一段，越早越粗，只留对现在仍然重要的事。`,
      `   原来的前情概要：${summary.trim() || '（空）'}`,
      ...tasks.fold.archives.map((a) => `   ${a.text}`),
      ...tasks.fold.milestones.map((m) => `   - ${m.text}`)
    );
    if (tasks.fold.legacy)
      lines.push(
        '   这段对话以前的记忆区原文（格式不同，只取内容）：',
        clip(tasks.fold.legacy.text, MEMORY_BAR_PROMPT_WINDOW.legacyChars, 'tail')
      );
  } else lines.push('4. 不需要改写前情概要，summary 写 null。');
  return lines.join('\n');
}

export function buildMemoryBarPromptMessages(input: MemoryBarPromptInput): {
  system: string;
  user: string;
} {
  const known = memoryBarText(input.state);
  const parts = [
    `【角色卡】${input.character.name}`,
    `【已有记忆】（只读，不要复述或改写）\n${known || '还没有。'}`,
    dialogueBlock(input.turns, input.tasks.fromTurn),
    taskBlock(input.tasks, input.state.summary),
  ];
  if (input.retryIssues?.length)
    parts.push(
      `【上一次输出的问题】\n${input.retryIssues.map((issue) => `- ${issue}`).join('\n')}\n请改正后重新输出完整的 JSON。`
    );
  parts.push('请只输出 JSON。');
  return { system: MEMORY_BAR_SYSTEM_PROMPT, user: parts.join('\n\n') };
}
