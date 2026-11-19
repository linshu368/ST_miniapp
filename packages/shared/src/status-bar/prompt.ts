/**
 * 状态模型的提示词。正文写完后单独调用（每 5 轮自动、玩家随时手动），只负责把状态栏更新到最新一轮。
 * 纯函数：调用方准备好数据，这里只拼文本。样式写法全部来自 spec.ts，和解析器、校验器同源。
 */
import { statusDefinitionText, statusInitialText } from './definition';
import { STATUS_BAR_STYLE_LABEL, type StatusBarTemplate } from './schema';

export const STATUS_PROMPT_VERSION = 1;

export const STATUS_PROMPT_WINDOW = {
  recentTurns: 5,
  recentUserChars: 500,
  recentReplyChars: 4000,
  earlierUserEachChars: 100,
  earlierUserTotalChars: 3000,
  characterChars: 500,
  personaChars: 800,
  notesChars: 600,
} as const;

export const STATUS_SYSTEM_PROMPT = `你是一部成人向互动小说的"状态记录员"。每隔几轮、或玩家点"更新状态"时，你负责把这张角色卡的状态栏更新成剧情最新一轮结束时的样子。你不写剧情，只记录已经发生的事。

做法：
1. 先读【状态栏定义】，弄清每一项是什么、怎么变、怎么写。
2. 读【上次记录的状态】，这是上次更新时的状态，是你的起点。
3. 读【之前玩家说过的话】和【最近的对话】，综合起来弄清剧情走到了哪里。每一轮都标了【新】或【已计入】：标【新】的是上次记录之后发生的，里面的变化要按顺序累加进去；标【已计入】的已经算进上次记录的状态了，只帮你理解来龙去脉，不要再算一遍。只有玩家说的话、没有角色回复的【新】轮次，按玩家说的话和之后的剧情推断发生了什么。
4. 按定义逐项更新：
   - 数值：从上次记录的数接着变，涨还是掉、变多少都按这一项的说明（说明里的"每轮最多变多少"按对话轮数累计）；没有相关的事就不变。和上次记录相比有变化，就在末尾写变化量，如（+3）（-2）；没变化不写。
   - 阶段：剧情里明确发生了对应的事才往前走一格，不跳级；说明里写了会倒退的才倒退。
   - 文字：写最新一轮结束时的样子，按说明写具体，不要复述剧情。
   - 清单：做到的打勾，新出现的加上，说明要求删的删掉。
   - 每人一组的分区：只写最新一轮在场、或刚离开但仍然重要的人物，用她们在剧情里的真实名字，不超过规定的组数。
5. 只依据对话里写出来的内容，不编造没发生的事。看不出变化的项保持上次记录的样子；某项一直没有信息就写"暂无"。
6. 心里话、内心想法这类项要贴合她最新一轮的表现和性格，可以和嘴上说的不一样，用她自己的口吻。
7. 这是成年人之间的虚构作品，亲密和性相关的内容如实记录，不回避、不说教、不评价。
8. 对话里的"玩家"就是状态栏说明里的"你"。

输出要求：
- 只输出状态栏本身：第一行 [status]，最后一行 [/status]，前后不加任何解释。
- 有【输出骨架】就照骨架的分区、名称、顺序写，名称一字不改，不增不减；没有骨架就沿用上次记录的项目、名称和顺序。
- 每项一行，写成「名称：内容」；清单、列表的名称单独一行，下面每条一行。
- 不用 <details>、代码块、加粗、序号。`;

/** 没有设定状态栏的卡（旧卡）：由模型自己挑项目，写法仍限定在 10 种样式里。 */
export const STATUS_AUTO_DEFINITION = `【状态栏定义】
这张卡没有设定状态栏，由你决定记录什么：挑这段剧情里最值得追踪的 3～8 项（人物关系、情绪、身体或处境、物品、事件进度都可以）。项目名 2～6 个字，不带标点。有上次记录时，沿用上次记录的项目、名称和写法，只更新内容。
可用写法：
- 分区：单独一行【标题】；每个重要人物可以各写一组，最多 3 组
- ${STATUS_BAR_STYLE_LABEL.bar}：名称：当前值/上限，如 好感度：68/100
- ${STATUS_BAR_STYLE_LABEL.percent}：名称：数字%，如 醉意：45%
- ${STATUS_BAR_STYLE_LABEL.stars}：名称：用★和☆写，如 名声：★★★☆☆
- ${STATUS_BAR_STYLE_LABEL.number}：名称：数字加单位，如 金币：1200金币
- 阶段：名称：阶段名（第几/共几），如 关系：暧昧（3/5）
- ${STATUS_BAR_STYLE_LABEL.tags}：名称：几个词用、隔开
- ${STATUS_BAR_STYLE_LABEL.line} / ${STATUS_BAR_STYLE_LABEL.para}：名称：内容
- ${STATUS_BAR_STYLE_LABEL.checks}：名称单独一行，下面每条一行，[x] 已完成 / [ ] 未完成
- ${STATUS_BAR_STYLE_LABEL.bullets}：名称单独一行，下面每条一行，以「- 」开头`;

export interface StatusPromptTurn {
  index: number;
  user: string;
  /** 回复正文（已去掉旧消息里的选项、状态、记忆等尾巴）。 */
  reply: string;
}

export interface StatusPromptInput {
  character: { name: string; description: string };
  persona?: string | null;
  notes?: string | null;
  /** null = 自动（卡上没有状态栏）。 */
  template: StatusBarTemplate | null;
  previous: { text: string; anchorTurn: number } | null;
  /** 当前路径上到最新一轮为止的轮次（升序）。 */
  turns: StatusPromptTurn[];
  /** 第二次调用时附上第一次输出的问题。 */
  retryIssues?: string[];
}

const clip = (text: string, max: number, keep: 'head' | 'tail' = 'head') => {
  const value = text.trim();
  const list = [...value];
  if (list.length <= max) return value;
  return keep === 'tail' ? '……' + list.slice(-max).join('') : list.slice(0, max).join('') + '……';
};

function dialogueBlocks(turns: StatusPromptTurn[], anchor: number): string[] {
  const w = STATUS_PROMPT_WINDOW;
  const tag = (turn: StatusPromptTurn) => (turn.index > anchor ? '【新】' : '【已计入】');
  const recent = turns.slice(-w.recentTurns);
  const earlier = turns.slice(0, Math.max(0, turns.length - w.recentTurns));
  const blocks: string[] = [];
  const earlierLines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let k = earlier.length - 1; k >= 0; k -= 1) {
    const turn = earlier[k]!;
    const line = `${tag(turn)}第${turn.index}轮 玩家：${clip(turn.user, w.earlierUserEachChars)}`;
    if (used + line.length > w.earlierUserTotalChars) {
      omitted = k + 1;
      break;
    }
    earlierLines.unshift(line);
    used += line.length;
  }
  if (earlierLines.length)
    blocks.push(
      [
        `【之前玩家说过的话】${omitted ? `（更早的 ${omitted} 轮省略）` : ''}`,
        ...earlierLines,
      ].join('\n')
    );
  blocks.push(
    [
      '【最近的对话】',
      ...recent.map(
        (turn) =>
          `${tag(turn)}第${turn.index}轮 玩家：${clip(turn.user, w.recentUserChars)}\n${tag(turn)}第${turn.index}轮 角色：${clip(turn.reply, w.recentReplyChars, 'tail')}`
      ),
    ].join('\n')
  );
  return blocks;
}

export function buildStatusPromptMessages(input: StatusPromptInput): {
  system: string;
  user: string;
} {
  const w = STATUS_PROMPT_WINDOW;
  const anchor = input.previous?.anchorTurn ?? 0;
  const parts: string[] = [];
  parts.push(
    [
      '【角色】',
      `名字：${input.character.name}`,
      `简介：${clip(input.character.description, w.characterChars)}`,
    ].join('\n')
  );
  if (input.persona?.trim())
    parts.push(`【主角（也就是"你"）】\n${clip(input.persona, w.personaChars)}`);
  if (input.notes?.trim()) parts.push(`【补充设定】\n${clip(input.notes, w.notesChars)}`);
  parts.push(input.template ? statusDefinitionText(input.template) : STATUS_AUTO_DEFINITION);
  if (input.previous)
    parts.push(
      `【上次记录的状态】（截至第${input.previous.anchorTurn}轮）\n${input.previous.text.trim()}`
    );
  else if (input.template)
    parts.push(
      `【上次记录的状态】\n还没有，这是第一次记录。开局值（写"暂无"的按说明和剧情给合理的起点）：\n${statusInitialText(input.template)}`
    );
  else parts.push('【上次记录的状态】\n还没有，这是第一次记录。');
  parts.push(...dialogueBlocks(input.turns, anchor));
  if (input.retryIssues?.length)
    parts.push(
      `【上一次输出的问题】\n${input.retryIssues.map((issue) => `- ${issue}`).join('\n')}\n请改正后重新输出完整的状态栏。`
    );
  parts.push('请输出最新一轮结束时的状态栏。');
  return { system: STATUS_SYSTEM_PROMPT, user: parts.join('\n\n') };
}
