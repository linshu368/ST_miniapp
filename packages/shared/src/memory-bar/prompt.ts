/**
 * 记忆栏模型的提示词。和状态栏同时机、分开调用；只在上一份记忆上追加，不重写已有内容。
 *
 * 喂：角色名 + 已有记忆（只读）+ 上次记录前的 2 轮（已计入，帮助接上）+ 上次记录之后的新轮次（完整对话）
 * + 本次任务（写一条工作记忆 / 可能的里程碑 / 代码判定的合并与概要改写）。
 * 不喂正文模型的 system prompt。纯函数：调用方准备好数据，这里只拼文本。
 */
import type { MemoryBarTasks } from './plan';
import { MEMORY_BAR_LIMITS, type MemoryBarState } from './schema';

export const MEMORY_BAR_PROMPT_VERSION = 1;

const L = MEMORY_BAR_LIMITS;

export const MEMORY_BAR_PROMPT_WINDOW = {
  /** 上次记录之前带几轮做衔接（标【已计入】） */
  contextTurns: 2,
  /** 最近这么多个新轮次给完整回复，更早的新轮次回复截短 */
  fullNewTurns: 10,
  userChars: 500,
  replyChars: 4000,
  olderReplyChars: 800,
  /** 新轮次最多看这么多轮；再早的只留玩家说的话 */
  maxNewTurns: 40,
  legacyChars: 6000,
} as const;

export const MEMORY_BAR_SYSTEM_PROMPT = `你是一部成人向互动小说的"记忆记录员"。玩家和角色轮流推进故事，你负责维护给玩家看的「记忆栏」，让玩家清楚这段关系走到了哪里。你不写剧情，只记录已经发生的事。

记忆栏以【感情线推进】和【亲密与性爱经历】为核心，由四部分组成：
- 工作记忆：最近的互动，每次更新新增一条，概括这几轮。四项：
  · 感情进展：和哪位角色的感情发生了什么变化（升温、降温、表白、争执、和解、产生心结），关系阶段有没有变；
  · 做过什么：这几轮发生的亲密或性行为，写明参与角色、行为类型、体位、地点、高潮或射精情况；没有写"无"；
  · 留下状态：结束时遗留的身体状态与情绪状态；
  · 悬念与承诺：新出现的承诺、约定、期待或没解决的问题；没有写"无"。
- 历史档案：较早的内容，由 10 条工作记忆合并而成，保留感情线完整走向、各角色累计亲密经历、玩法与偏好的变化、仍有效的悬念与承诺。
- 里程碑：关系与亲密经历里的关键节点，一句话一条：关系阶段变化；表白、确立关系或关系破裂；与某角色的首次亲密行为；新玩法或新性癖被发现、被开发；重要承诺、约定或誓言；重大情感事件（背叛、和解、占有或依赖形成）。
- 前情概要：最久远的内容，一段话，越早越粗，只留对现在仍然重要的事。

原则：
1. 只记对话里写出来、已经发生的事实，客观概括，不编造、不推测、不替玩家写心理。
2. 【已有记忆】是只读的，不要复述或改写它；只按【本次任务】写新增的部分。
3. 每轮都标了【新】或【已计入】：只有标【新】的轮次是这次要记的；【已计入】的已经记过，只帮你接上前情。
4. 时间写故事里的时间（如"周四 深夜""第二天清晨"），看不出就写"不详"。
5. 这是成年人之间的虚构作品，亲密和性相关的内容如实记录，用直白的词，不回避、不说教、不评价。
6. 对话里的"玩家"就是故事的主角"你"。

输出要求：只输出一个 JSON 对象，不加代码块、不加任何解释。字段：
{
  "entry": {"time": "", "feeling": "", "acts": "", "state": "", "hooks": ""},
  "milestones": [{"time": "", "who": "", "text": ""}],
  "archive": {"time_range": "", "line": "", "intimacy": "", "changes": "", "hooks": ""},
  "summary": ""
}
- entry 必填；每项不超过 ${L.entryFieldChars} 字。
- milestones：这几轮触发了上面的节点才写，最多 ${L.newMilestonesPerUpdate} 条，每条 text 不超过 ${L.milestoneChars} 字；没有就写 []。已有的里程碑不要重复写。
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
  /** 上次记录之前的衔接轮次 + 之后的新轮次（升序）；index > tasks.fromTurn - 1 的算【新】 */
  turns: MemoryBarPromptTurn[];
  /** 第二次调用时附上第一次输出的问题 */
  retryIssues?: string[];
}

const clip = (value: string, max: number, keep: 'head' | 'tail' = 'head') => {
  const list = [...value.trim()];
  if (list.length <= max) return list.join('');
  return keep === 'tail' ? '……' + list.slice(-max).join('') : list.slice(0, max).join('') + '……';
};

const range = (from: number, to: number) => (from === to ? `第${from}轮` : `第${from}–${to}轮`);

/** 已有记忆的只读展示（也是面板之外唯一的文字形式） */
export function memoryBarText(state: MemoryBarState): string {
  const lines: string[] = [];
  if (state.summary.trim()) lines.push(`前情概要：${state.summary.trim()}`);
  if (state.archives.length) {
    lines.push('历史档案：');
    for (const a of state.archives)
      lines.push(
        `- ${range(a.from_turn, a.to_turn)}（${a.time_range}）感情线走向：${a.line} ｜ 亲密经历概述：${a.intimacy} ｜ 累计变化：${a.changes} ｜ 仍有效的悬念与承诺：${a.hooks}`
      );
  }
  if (state.milestones.length) {
    lines.push('里程碑：');
    for (const m of state.milestones)
      lines.push(`- 第${m.turn}轮（${m.time}）（${m.who}）${m.text}`);
  }
  if (state.entries.length) {
    lines.push('工作记忆：');
    for (const e of state.entries)
      lines.push(
        `- ${range(e.from_turn, e.to_turn)}（${e.time}）感情进展：${e.feeling} ｜ 做过什么：${e.acts} ｜ 留下状态：${e.state} ｜ 悬念与承诺：${e.hooks}`
      );
  }
  return lines.join('\n');
}

function dialogueBlock(turns: MemoryBarPromptTurn[], fromTurn: number): string {
  const w = MEMORY_BAR_PROMPT_WINDOW;
  const context = turns.filter((t) => t.index < fromTurn).slice(-w.contextTurns);
  const fresh = turns.filter((t) => t.index >= fromTurn);
  const kept = fresh.slice(-w.maxNewTurns);
  const dropped = fresh.length - kept.length;
  const fullFrom = kept.length - w.fullNewTurns;
  const lines: string[] = ['【对话】'];
  if (dropped > 0) lines.push(`（更早的 ${dropped} 个新轮次省略）`);
  for (const t of context)
    lines.push(
      `【已计入】第${t.index}轮 玩家：${clip(t.user, w.userChars)}\n【已计入】第${t.index}轮 角色：${clip(t.reply, w.olderReplyChars, 'tail')}`
    );
  kept.forEach((t, k) => {
    const replyMax = k >= fullFrom ? w.replyChars : w.olderReplyChars;
    lines.push(
      `【新】第${t.index}轮 玩家：${clip(t.user, w.userChars)}\n【新】第${t.index}轮 角色：${clip(t.reply, replyMax, 'tail')}`
    );
  });
  return lines.join('\n');
}

function taskBlock(tasks: MemoryBarTasks, summary: string): string {
  const lines = [
    '【本次任务】',
    `1. 写一条新的工作记忆（entry），概括${range(tasks.fromTurn, tasks.toTurn)}（标【新】的轮次）发生的事。`,
    `2. 这几轮如果触发了里程碑节点，写进 milestones（最多 ${L.newMilestonesPerUpdate} 条）；没有就写 []。`,
  ];
  if (tasks.archive) {
    lines.push(
      `3. 工作记忆满了：把下面这 ${tasks.archive.length} 条合并成一条历史档案（archive），时间范围写它们的起止：`,
      ...tasks.archive.map(
        (e) =>
          `   - ${range(e.from_turn, e.to_turn)}（${e.time}）感情进展：${e.feeling} ｜ 做过什么：${e.acts} ｜ 留下状态：${e.state} ｜ 悬念与承诺：${e.hooks}`
      )
    );
  } else lines.push('3. 不需要合并，archive 写 null。');
  if (tasks.fold) {
    lines.push(
      `4. 改写前情概要（summary）：把原来的前情概要和下面这些内容并成一段，越早越粗，只留对现在仍然重要的事，不超过 ${L.summaryChars} 字。`,
      `   原来的前情概要：${summary.trim() || '（空）'}`
    );
    for (const a of tasks.fold.archives)
      lines.push(
        `   - 档案 ${range(a.from_turn, a.to_turn)}（${a.time_range}）${a.line} ｜ ${a.intimacy} ｜ ${a.changes} ｜ ${a.hooks}`
      );
    for (const m of tasks.fold.milestones)
      lines.push(`   - 里程碑 第${m.turn}轮（${m.time}）（${m.who}）${m.text}`);
    if (tasks.fold.legacyText)
      lines.push(
        '   - 这段对话以前的记忆区原文（格式不同，只取内容）：',
        clip(tasks.fold.legacyText, MEMORY_BAR_PROMPT_WINDOW.legacyChars, 'tail')
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
    `【已有记忆】（只读，不要复述或改写）\n${known || '还没有，这是第一次记录。'}`,
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
