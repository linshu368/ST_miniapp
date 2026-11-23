/**
 * backend / features / conversations / history.ts
 *
 * 上下文切片（M3b）。纯函数。
 *
 * chat_history 一行保存一轮的一个 revision。仓库已经只取当前 turn 之前各轮的最大 revision，
 * 这里负责把开场白放在最前并过滤空回复。本轮 userInput 独立交给引擎，不会混进 history。
 */

import { splitEditableReply } from '@miniapp/shared';
import type { EngineHistoryMessage } from '../engine/index.js';
import type { StoryTurn } from '../story-memory/text.js';

/** 历史中一条中断回复允许入模的正文上限；中断回复可能是循环输出，不能整条带进后续每一轮。 */
export const INTERRUPTED_REPLY_BODY_MAX_CHARS = 6_000;

/**
 * 开场白没有独立数据库行：首轮用角色卡当前值，之后用首轮 history 中保存的快照。
 */
export function buildEngineHistory(
  context: EngineHistoryMessage[],
  openingMessage: string
): EngineHistoryMessage[] {
  const history: EngineHistoryMessage[] = [];
  if (openingMessage.trim()) {
    history.push({ role: 'assistant', content: openingMessage });
  }
  history.push(
    ...context
      .filter((message) => message.content.trim() !== '')
      .map((message) => ({ role: message.role, content: message.content }))
  );
  return history;
}

/** 窗口内轮次 → 入模消息。空输入/空回复不进 prompt，但轮次仍占窗口位置。 */
export function turnsToMessages(
  turns: StoryTurn[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns.flatMap((turn) => {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (turn.userInput.trim()) messages.push({ role: 'user', content: turn.userInput });
    if (turn.assistantReply?.trim()) {
      messages.push({ role: 'assistant', content: turn.assistantReply });
    }
    return messages;
  });
}

/**
 * 窗口内轮次 → 聊天 prompt 的历史消息。
 *
 * 选项和记忆栏原样保留：模型靠前文示范维持"每轮都出选项/记忆栏"。2026-11-17 起旧轮次只带正文后，
 * 选项输出率从约 75% 掉到约 45%、记忆栏从 60% 掉到 33%，且漏一次后下一轮更容易再漏（11-19 生产数据）。
 * 状态栏、记忆栏已改由独立模型记录、右侧面板展示，正文模型不再输出，历史里的旧状态栏、旧记忆区一律剥掉，免得模型照着写。
 * 中断回复不保留尾部，正文超过上限时截断。
 */
export function turnsToPromptMessages(
  turns: StoryTurn[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns.flatMap((turn) => {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (turn.userInput.trim()) messages.push({ role: 'user', content: turn.userInput });
    const reply = turn.assistantReply;
    if (reply?.trim()) {
      const content =
        turn.status === 'stream_interrupted'
          ? splitEditableReply(reply).body.slice(0, INTERRUPTED_REPLY_BODY_MAX_CHARS)
          : stripPanelBlocks(reply);
      if (content.trim()) messages.push({ role: 'assistant', content });
    }
    return messages;
  });
}

/** 旧状态栏块（含没闭合、直接接记忆栏或到结尾的）连同前面的空白一起去掉；没有状态栏的回复原样返回。 */
const STATUS_BLOCK = /\s*\[status\][\s\S]*?(?:\[\/status\]|(?=\s*\[memory\])|$)/g;

/** 旧记忆区（含没闭合、到结尾的）连同前面的空白一起去掉。 */
const MEMORY_BLOCK = /\s*\[memory\][\s\S]*?(?:\[\/memory\]|$)/gi;

function stripPanelBlocks(reply: string): string {
  const withoutStatus = reply.includes('[status]') ? reply.replace(STATUS_BLOCK, '') : reply;
  return /\[memory\]/i.test(withoutStatus)
    ? withoutStatus.replace(MEMORY_BLOCK, '')
    : withoutStatus;
}
