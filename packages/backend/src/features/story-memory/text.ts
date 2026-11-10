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
