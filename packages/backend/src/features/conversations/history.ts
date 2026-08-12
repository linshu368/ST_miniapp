/**
 * backend / features / conversations / history.ts
 *
 * 上下文切片（M3b）。纯函数。
 *
 * chat_history 一行保存一轮的一个 revision。仓库已经只取当前 turn 之前各轮的最大 revision，
 * 这里负责把开场白放在最前并过滤空回复。本轮 userInput 独立交给引擎，不会混进 history。
 */

import type { EngineHistoryMessage } from '../engine/index.js';

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
