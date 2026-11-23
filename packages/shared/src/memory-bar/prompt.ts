/**
 * 记忆栏模型的提示词。和状态栏同时机、分开调用；只在上一份记忆上追加，不重写已有内容。
 *
 * 按事件记，不按轮次记：模型先判断上一件记下的事之后剧情有没有真的往前走，有才记，没有就什么都不写。
 * 喂：角色名 + 已有记忆（只读）+ 上一件事之前的 2 轮（已记过，帮助接上）+ 之后的对话 + 本次任务。
 * 不喂正文模型的 system prompt。纯函数：调用方准备好数据，这里只拼文本。
 */
import type { MemoryBarTasks } from './plan';
import { MEMORY_BAR_LIMITS, type MemoryBarState } from './schema';

export const MEMORY_BAR_PROMPT_VERSION = 2;

const L = MEMORY_BAR_LIMITS;

export const MEMORY_BAR_PROMPT_WINDOW = {
  /** 上一件事之前带几轮做衔接（标【已记过】） */
  contextTurns: 2,
  /** 最近这么多轮给完整回复，更早的截短 */
  fullTurns: 10,
  userChars: 500,
  replyChars: 4000,
  olderReplyChars: 800,
  /** 最多看这么多轮；再早的一直没进展，不用再看 */
  maxTurns: 40,
  legacyChars: 6000,
} as const;

export const MEMORY_BAR_SYSTEM_PROMPT = `你是一部成人向互动小说的"记忆记录员"。玩家和角色轮流推进故事，你负责维护给玩家看的「记忆栏」，让玩家心里有底：这段关系、这个故事走到了哪里。你不写剧情，只记录已经发生的事。

最重要的一条：记忆栏按事件记，不按轮次记。
- 只有剧情真的往前走了才记：感情发生变化（升温、降温、表白、争执、和解、产生心结、关系阶段改变）；第一次发生的亲密行为、尺度或玩法升级；做出承诺、约定，或者旧的悬念有了结果；重要的剧情事件（相遇、离开、秘密揭开、身份改变、受伤、怀孕之类）；持续生效的状态变了（关系规则、穿戴、身体变化）。
- 闲聊、日常、重复上次做过的亲密、气氛描写、原地打转，都不算进展。
- 没有进展就什么都不写，这很正常。不要为了记而记，不要把小事拆开凑数，也不要把同一件事换个说法再记一遍。

记忆栏的四部分：
- 近期事件：一件事一条。写：时间、事件（一句话说清发生了什么）、感情进展、做过什么（亲密或性行为：参与角色、行为、地点、高潮或射精情况）、留下状态（身体与情绪）、悬念与承诺。某项没有就写"无"。
- 历史档案：较早的几件事合并而成，保留感情线走向、亲密经历、累计变化、仍有效的悬念与承诺。
- 里程碑：关系与亲密经历里的关键节点，一句话一条：关系阶段变化；表白、确立关系或关系破裂；与某角色的首次亲密行为；新玩法或新性癖被发现、被开发；重要承诺、约定或誓言；重大情感事件（背叛、和解、占有或依赖形成）。
- 前情概要：最久远的内容，一段话，越早越粗，只留对现在仍然重要的事。

原则：
1. 只记对话里写出来、已经发生的事实，客观概括，不编造、不推测、不替玩家写心理。
2. 【已有记忆】是只读的，不要复述或改写它；只按【本次任务】写新增的部分。
3. 对话里标【已记过】的轮次只帮你接上前情，里面的事不要再记。
4. 时间写故事里的时间（如"周四 深夜""第二天清晨"），看不出就写"不详"；不要写"第几轮"。
5. 这是成年人之间的虚构作品，亲密和性相关的内容如实记录，用直白的词，不回避、不说教、不评价。
6. 对话里的"玩家"就是故事的主角"你"。

输出要求：只输出一个 JSON 对象，不加代码块、不加任何解释。字段：
{
  "events": [{"time": "", "title": "", "feeling": "", "acts": "", "state": "", "hooks": ""}],
  "milestones": [{"time": "", "who": "", "text": ""}],
  "archive": {"time_range": "", "line": "", "intimacy": "", "changes": "", "hooks": ""},
  "summary": ""
}
- events：有进展才写，最多 ${L.newEntriesPerUpdate} 件（两件互不相干的大事才分开）；没有进展写 []。title 不超过 ${L.entryTitleChars} 字，其余每项不超过 ${L.entryFieldChars} 字。
- milestones：触发了上面的节点才写，最多 ${L.newMilestonesPerUpdate} 条，每条 text 不超过 ${L.milestoneChars} 字；没有写 []。已有的里程碑不要重复写。
- archive：只有【本次任务】要求合并时才写，每项不超过 ${L.archiveFieldChars} 字；否则写 null。
- summary：只有【本次任务】要求改写前情概要时才写，整段不超过 ${L.summaryChars} 字；否则写 null。`;

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

const eventLine = (e: MemoryBarState['entries'][number]) =>
  `（${e.time}）${e.title} ｜ 感情进展：${e.feeling} ｜ 做过什么：${e.acts} ｜ 留下状态：${e.state} ｜ 悬念与承诺：${e.hooks}`;

/** 已有记忆的文字形式（喂模型用；不带轮次） */
export function memoryBarText(state: MemoryBarState): string {
  const lines: string[] = [];
  if (state.summary.trim()) lines.push(`前情概要：${state.summary.trim()}`);
  if (state.archives.length) {
    lines.push('历史档案：');
    for (const a of state.archives)
      lines.push(
        `- （${a.time_range}）感情线走向：${a.line} ｜ 亲密经历概述：${a.intimacy} ｜ 累计变化：${a.changes} ｜ 仍有效的悬念与承诺：${a.hooks}`
      );
  }
  if (state.milestones.length) {
    lines.push('里程碑：');
    for (const m of state.milestones) lines.push(`- （${m.time}）（${m.who}）${m.text}`);
  }
  if (state.entries.length) {
    lines.push('近期事件：');
    for (const e of state.entries) lines.push(`- ${eventLine(e)}`);
  }
  return lines.join('\n');
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
      `【已记过】第${t.index}轮 玩家：${clip(t.user, w.userChars)}\n【已记过】第${t.index}轮 角色：${clip(t.reply, w.olderReplyChars, 'tail')}`
    );
  if (dropped > 0) lines.push(`（中间还有 ${dropped} 轮，一直没记下什么，省略）`);
  kept.forEach((t, k) => {
    const replyMax = k >= fullFrom ? w.replyChars : w.olderReplyChars;
    lines.push(
      `第${t.index}轮 玩家：${clip(t.user, w.userChars)}\n第${t.index}轮 角色：${clip(t.reply, replyMax, 'tail')}`
    );
  });
  return lines.join('\n');
}

function taskBlock(tasks: MemoryBarTasks, summary: string): string {
  const lines = [
    '【本次任务】',
    '1. 看上一件记下的事之后（没标【已记过】的轮次），剧情有没有真的往前走。有就写进 events，没有就写 []——没进展很正常，不要硬写。',
    '2. 有触发里程碑节点的，写进 milestones；没有写 []。',
  ];
  if (tasks.archive) {
    lines.push(
      `3. 近期事件快满了：把下面最早的 ${tasks.archive.length} 件合并成一条历史档案（archive），时间范围写它们的起止：`,
      ...tasks.archive.map((e) => `   - ${eventLine(e)}`)
    );
  } else lines.push('3. 不需要合并，archive 写 null。');
  if (tasks.fold) {
    lines.push(
      `4. 改写前情概要（summary）：把原来的前情概要和下面这些内容并成一段，越早越粗，只留对现在仍然重要的事，不超过 ${L.summaryChars} 字。`,
      `   原来的前情概要：${summary.trim() || '（空）'}`
    );
    for (const a of tasks.fold.archives)
      lines.push(
        `   - 档案（${a.time_range}）${a.line} ｜ ${a.intimacy} ｜ ${a.changes} ｜ ${a.hooks}`
      );
    for (const m of tasks.fold.milestones)
      lines.push(`   - 里程碑（${m.time}）（${m.who}）${m.text}`);
    if (tasks.fold.legacy)
      lines.push(
        '   - 这段对话以前的记忆区原文（格式不同，只取内容）：',
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
    `【角色】${input.character.name}`,
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
