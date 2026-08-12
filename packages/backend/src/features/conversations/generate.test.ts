import { describe, expect, it } from 'vitest';
import { toEngineCharacter, toMessageStatus } from './generate.js';
import type { CharacterCardRow } from '../../infrastructure/repositories/CharacterCardRepository.js';

describe('toMessageStatus', () => {
  it('把生成出口的四种终态映射成消息行状态', () => {
    expect(toMessageStatus('success')).toBe('complete');
    // 对齐 llm-proxy 既有的 stream_interrupted 语义：保留半截正文，不算失败
    expect(toMessageStatus('stream_interrupted')).toBe('interrupted');
    expect(toMessageStatus('upstream_error')).toBe('failed');
    expect(toMessageStatus('insufficient_balance')).toBe('failed');
  });
});

describe('toEngineCharacter', () => {
  it('取齐接缝要求的字段组，不带 id 等非引擎字段', () => {
    const card: CharacterCardRow = {
      id: '11111111-1111-4111-8111-111111111111',
      name: '测试角色',
      description: '描述',
      personality: '性格',
      scenario: '场景',
      first_mes: '开场白',
      mes_example: '对话示例',
      system_prompt: '你是测试角色。',
      post_history_instructions: '历史后指令',
    };

    expect(toEngineCharacter(card)).toEqual({
      name: '测试角色',
      description: '描述',
      personality: '性格',
      scenario: '场景',
      first_mes: '开场白',
      mes_example: '对话示例',
      system_prompt: '你是测试角色。',
      post_history_instructions: '历史后指令',
    });
  });
});
