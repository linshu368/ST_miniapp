import { describe, expect, it } from 'vitest';
import { applyPromptCaching, isPromptCacheableModel } from './prompt-caching.js';
import type { GenerationMessage } from './types.js';

const MESSAGES: GenerationMessage[] = [
  { role: 'system', content: '角色卡 system_prompt' },
  { role: 'assistant', content: '开场白' },
  { role: 'user', content: '第一轮输入' },
  { role: 'assistant', content: '第一轮回复' },
  { role: 'user', content: '平台规则 + 本轮输入' },
];

function cachedIndexes(messages: ReturnType<typeof applyPromptCaching>): number[] {
  return messages.reduce<number[]>((acc, message, index) => {
    if (Array.isArray(message.content) && message.content[0]?.cache_control) acc.push(index);
    return acc;
  }, []);
}

describe('isPromptCacheableModel', () => {
  it('只有 anthropic 系需要显式断点', () => {
    expect(isPromptCacheableModel('anthropic/claude-sonnet-4.5')).toBe(true);
    expect(isPromptCacheableModel('Anthropic/Claude-3.7-Sonnet:beta')).toBe(true);
    expect(isPromptCacheableModel('google/gemini-3.1-flash-lite')).toBe(false);
    expect(isPromptCacheableModel('openai/gpt-5')).toBe(false);
  });
});

describe('applyPromptCaching', () => {
  it('非 anthropic 模型的 content 保持字符串原样', () => {
    const result = applyPromptCaching(MESSAGES, 'google/gemini-3.1-flash-lite');
    expect(result).toEqual(MESSAGES.map((m) => ({ role: m.role, content: m.content })));
  });

  it('断点打在 system 段与历史尾部，不打在本轮包装过的用户输入上', () => {
    const result = applyPromptCaching(MESSAGES, 'anthropic/claude-sonnet-4.5');
    // index 4 是「平台规则 + 本轮输入」，下一轮它会以原文重新出现，断点打上去必然 miss
    expect(cachedIndexes(result)).toEqual([0, 3]);
    expect(result[4]).toEqual({ role: 'user', content: '平台规则 + 本轮输入' });
  });

  it('断点之外的消息不被改写成 content 块', () => {
    const result = applyPromptCaching(MESSAGES, 'anthropic/claude-sonnet-4.5');
    expect(result[1]).toEqual({ role: 'assistant', content: '开场白' });
    expect(result[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: '角色卡 system_prompt', cache_control: { type: 'ephemeral' } },
      ],
    });
  });

  it('没有 system 段时只打历史尾部一个断点', () => {
    const withoutSystem = MESSAGES.slice(1);
    expect(cachedIndexes(applyPromptCaching(withoutSystem, 'anthropic/claude-sonnet-4.5'))).toEqual(
      [2]
    );
  });

  it('首轮（system + 本轮输入两条）只打 system 一个断点', () => {
    const firstTurn: GenerationMessage[] = [
      { role: 'system', content: '角色卡 system_prompt' },
      { role: 'user', content: '平台规则 + 本轮输入' },
    ];
    expect(cachedIndexes(applyPromptCaching(firstTurn, 'anthropic/claude-sonnet-4.5'))).toEqual([
      0,
    ]);
  });

  it('空内容不打断点（上游会拒绝空的 text 块）', () => {
    const withEmptySystem: GenerationMessage[] = [
      { role: 'system', content: '' },
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: '本轮输入' },
    ];
    expect(
      cachedIndexes(applyPromptCaching(withEmptySystem, 'anthropic/claude-sonnet-4.5'))
    ).toEqual([1]);
  });
});
