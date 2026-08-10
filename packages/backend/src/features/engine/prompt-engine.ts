/**
 * backend / features / engine / prompt-engine.ts
 *
 * Prompt 引擎 v1（M2）。纯函数、无 IO、无 DB，取数与落库都在调用方（M3b）。
 *
 * 移植自旧 bot 的 src/infrastructure/ai/SimplePromptEngine.ts 的 _buildMessages()。
 * 最终形状：
 *   [system: 角色卡 system_prompt] + 历史（含 turn 0 的开场白） + [user: 平台规则 + 本轮输入]
 *
 * 方案：docs/ST_remove-MVP实施方案.md §六。
 */

import type { EngineInput, EngineMessage, EngineOutput, PromptEngine } from './types.js';
import { renderPlatformInstructions, wrapUserInput } from './render-instructions.js';

/**
 * 组装本轮生成的 messages。
 *
 * 与 bot 的三处差异，都是前提不同导致的，不是设计变更：
 *
 * 1. **不注入 first_mes**。bot 的开场白不入库，所以每轮现场补一条；本方案决策 3 把开场白
 *    落成 turn 0 的普通 assistant 消息，history 里已经有了，再注入就是每轮重复一条。
 * 2. **不消费预设**（决策 7 二次修正）。system 段只有角色卡 system_prompt，
 *    description / personality / scenario / mes_example / post_history_instructions 全不进 prompt，
 *    与 bot 现状一致；ST 生态卡下架后再按新卡写法决定要不要并入。
 * 3. **不做上下文长度管理**（决策 10）。history 全量入 prompt，truncatedTurns 恒为 0。
 *
 * input.persona v1 未消费：模板里没有对应占位符，bot 也没有 persona 概念。
 */
export function buildPrompt(input: EngineInput): EngineOutput {
  const messages: EngineMessage[] = [];

  const systemPrompt = input.character.system_prompt;
  if (systemPrompt.trim() !== '') {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of input.history) {
    messages.push({ role: message.role, content: message.content });
  }

  const renderedInstructions = renderPlatformInstructions(input.instructions, input.userConfig);
  messages.push({ role: 'user', content: wrapUserInput(input.userInput, renderedInstructions) });

  return { messages, sampling: {}, truncatedTurns: 0 };
}

export const promptEngine: PromptEngine = { build: buildPrompt };
