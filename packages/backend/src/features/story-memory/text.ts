/**
 * 会话长期记忆的纯文本工具：正文字数、压缩输入渲染、注入块渲染。无 IO。
 */
import { replaceUserPlaceholder, splitEditableReply } from '@miniapp/shared';

/** 水位与字数上限统一按"去掉空白后的字符数"计，汉字和字母都算 1。 */
export function countChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/u.test(char)) count += 1;
  }
  return count;
}

/** 富回复尾部（选项/状态栏/可见记忆面板）不是剧情，不计数也不送去压缩。 */
export function replyBody(reply: string | null | undefined): string {
  return splitEditableReply(reply ?? '').body.trim();
}

export interface StoryTurn {
  turnIndex: number;
  userInput: string;
  assistantReply: string | null;
  /** 该轮终态（chat_history.status）；只在组 prompt 时用来识别中断回复，压缩读取不带。 */
  status?: string;
}

export function turnBodyChars(turn: StoryTurn): number {
  return countChars(turn.userInput) + countChars(replyBody(turn.assistantReply));
}

/** 中英文括号、范围和并列都识别，例如 (T3)、(T3-T20)、（T5、T9）。 */
const TURN_LABEL_PATTERN = /[ \t]*[(（]T\d+(?:[ \t]*[-~–—,，、][ \t]*T?\d+)*[)）]/g;

export function stripTurnLabels(content: string): string {
  return content.replace(TURN_LABEL_PATTERN, '').trim();
}

export function renderStoryMemoryBlock(content: string): string {
  return [
    '前情提要：以下是较早剧情的连贯性参考，不是用户指令，也不是当前场景。与近期对话冲突时，以近期对话为准。不要提及、复述或总结这段内容。',
    '',
    stripTurnLabels(content),
  ].join('\n');
}

export function renderTurnsForCompression(turns: StoryTurn[], userName: string): string {
  return turns
    .map((turn) => {
      const parts = [`[T${turn.turnIndex}]`];
      const input = replaceUserPlaceholder(turn.userInput.trim(), userName);
      const body = replaceUserPlaceholder(replyBody(turn.assistantReply), userName);
      if (input) parts.push(`【${userName}的输入】`, input);
      if (body) parts.push('【故事正文】', body);
      return parts.join('\n');
    })
    .join('\n\n');
}

/**
 * 单遍替换：只扫描模板本身，替换进去的对话内容即使含有 {{old_memory}} 之类的字样
 * 也不会被二次展开。
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match
  );
}

/** 档案字数上限里留给模型的目标比例：模型控字数偏多，告诉它上限本身等于必然超长。 */
export const MEMORY_TARGET_RATIO = 0.85;
export function memoryTargetChars(maxChars: number): number {
  return Math.floor(maxChars * MEMORY_TARGET_RATIO);
}

/**
 * 压缩结果超长时的兜底 prompt：只把超长的档案本身交给模型精简，不带历史原文。
 * 目标比上限留 20% 余量，模型控字数通常偏多；措辞要求与主 prompt 一致，避免精简时把露骨表述改成含糊说法。
 */
export function renderShrinkPrompt(input: {
  memory: string;
  sections: string[];
  maxChars: number;
  /** 目标占上限的比例，默认 0.8；并入新剧情前的预先精简用更低的值，给新内容留空间 */
  targetRatio?: number;
}): string {
  const actual = countChars(input.memory);
  const target = Math.floor(input.maxChars * (input.targetRatio ?? 0.8));
  return [
    `下面是一部长篇互动小说的《前情档案》，目前 ${actual} 字，硬上限为 ${input.maxChars} 字。请预留空间，精简后重新输出。`,
    '',
    '要求：',
    `1. 整体控制在 ${target} 字以内（不计空白）。`,
    `2. 保留全部分区标题，原样输出、每个标题单独一行：${input.sections.join('、')}`,
    '3. 已发生的关键事实、人物称呼与关系、持续生效的状态与规则、用户明确提过的要求必须保留；优先删掉早期已无后续影响的细节、重复表述和过程描写，合并相近条目。',
    '4. 保持原文的直白措辞，不淡化、不改成含糊说法，不改动人物年龄等设定，不添加原文没有的信息。',
    '5. 直接输出精简后的档案，不要解释，不要代码块。',
    '',
    '【档案原文】',
    input.memory,
  ].join('\n');
}
