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
 * 选项/状态栏/记忆栏（富回复尾部）占历史字数的大头，且每条都重复整份当前状态，
 * 所以旧轮次只带正文。最近一条正常结束的回复保留完整尾部：记忆规则要求模型沿用前文的
 * 记忆栏格式，而每轮输出的都是完整当前记忆区，最新一条已带全部状态。
 * 中断回复不保留尾部，正文超过上限时截断。
 */
export function turnsToPromptMessages(
  turns: StoryTurn[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  let keepTailIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.status !== 'stream_interrupted' && turn.assistantReply?.trim()) {
      keepTailIndex = index;
      break;
    }
  }
  return turns.flatMap((turn, index) => {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (turn.userInput.trim()) messages.push({ role: 'user', content: turn.userInput });
    const reply = turn.assistantReply;
    if (reply?.trim()) {
      let content = index === keepTailIndex ? reply : splitEditableReply(reply).body;
      if (turn.status === 'stream_interrupted') {
        content = content.slice(0, INTERRUPTED_REPLY_BODY_MAX_CHARS);
      }
      if (content.trim()) messages.push({ role: 'assistant', content });
    }
    return messages;
  });
}
