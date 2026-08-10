/**
 * backend / features / generation / prompt-caching.ts
 *
 * OpenRouter 的 Anthropic prompt 缓存断点（决策 11）。纯函数，无 IO。
 *
 * Anthropic 系模型不会自动缓存，必须在 content 块上显式打 cache_control 断点，
 * 命中后断点之前的 token 按缓存价计费。其余厂商（OpenAI / Gemini 等）自动缓存，
 * 带上这个字段反而可能被上游拒绝，所以只对 anthropic/* 生效。
 *
 * ⚠️ 这是相对 ST 链路现状的行为变更（今天一个断点都不打），因此由
 * GenerationRequest.promptCaching 开关控制：ST 链路必须传 false，保住 M3a
 * 「行为零变化」的回归判据；自研链路传 true。
 */

import type { GenerationMessage } from './types.js';

export interface PromptCacheTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface UpstreamMessage {
  role: string;
  content: string | PromptCacheTextBlock[];
}

export function isPromptCacheableModel(openRouterModelId: string): boolean {
  return openRouterModelId.toLowerCase().startsWith('anthropic/');
}

/**
 * 在 system 段与历史尾部各打一个断点。
 *
 * 断点刻意不打在最后一条消息上：引擎组装出的最后一条 user 消息是「平台规则 + 本轮输入」
 * 的包装体，而下一轮它会以未包装的原文重新出现在历史里，前缀对不上必然 miss。
 * 退一位打在历史最后一条上，缓存的前缀才是两轮都逐字相同的部分。
 *
 * 不可缓存的模型原样返回，调用方无需自己判型号。
 */
export function applyPromptCaching(
  messages: GenerationMessage[],
  openRouterModelId: string
): UpstreamMessage[] {
  if (!isPromptCacheableModel(openRouterModelId)) {
    return messages.map((message) => ({ role: message.role, content: message.content }));
  }

  const breakpoints = new Set<number>();
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex >= 0) breakpoints.add(systemIndex);

  const historyTailIndex = messages.length - 2;
  if (historyTailIndex >= 0 && historyTailIndex !== systemIndex) {
    breakpoints.add(historyTailIndex);
  }

  return messages.map((message, index) => {
    if (!breakpoints.has(index) || message.content === '') {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }],
    };
  });
}
