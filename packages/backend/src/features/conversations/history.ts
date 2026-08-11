/**
 * backend / features / conversations / history.ts
 *
 * 上下文切片（M3b）。纯函数。
 *
 * M1 的 getContextMessages 返回**有序全量**：不截断，也不切掉尾部本轮 user 消息
 * （方案 §5.5 把这件事明确划给 M3b，因为 EngineInput 把本轮输入拆成了独立的 userInput）。
 * 这里就是那道切片，两条生成路径共用一份实现——分开写迟早会漂移。
 *
 * 调用时机决定了尾部形态：
 *   发消息：append_chat_turn 之后读，尾部是本轮 user 行
 *   重生成：start_message_regeneration 之后读，尾部是本轮 user 行 + 新插入的空占位 assistant 行
 * 空正文过滤把后者连同「402 / 上游失败留下的空 assistant 行」一起清掉，
 * 两条路径因此收敛成同一条规则，不必让调用方声明自己处在哪种形态。
 */

import type { EngineHistoryMessage } from '../engine/index.js';
import type { ChatContextMessage } from '../../infrastructure/repositories/ChatMessageRepository.js';

export interface EngineHistoryResult {
  history: EngineHistoryMessage[];
  /**
   * 尾部切掉的那条 user 消息与本轮输入不一致。
   * 正常不会发生，出现即意味着读上下文期间这个会话被并发写过，调用方据此打点。
   */
  tailMismatch: boolean;
}

/**
 * 把有序全量上下文切成引擎要的 history。
 *
 * 两步：
 *   1. 丢掉空正文消息——流式占位行（content = ''）与失败收口留下的空行都不该进 prompt，
 *      部分上游还会直接拒收 content 为空的消息
 *   2. 丢掉尾部那条 user 消息——它是本轮输入，由 EngineInput.userInput 单独承载，
 *      混在 history 里会让平台规则包装的那条与它重复一遍
 */
export function buildEngineHistory(
  context: ChatContextMessage[],
  userInput: string
): EngineHistoryResult {
  const history: EngineHistoryMessage[] = context
    .filter((message) => message.content.trim() !== '')
    .map((message) => ({ role: message.role, content: message.content }));

  const tail = history[history.length - 1];
  if (!tail || tail.role !== 'user') {
    // 没有尾部 user 消息就没什么可切的：只可能是并发写或数据异常，交给调用方打点。
    return { history, tailMismatch: true };
  }

  history.pop();
  return { history, tailMismatch: tail.content !== userInput };
}
