import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';

import { mergeStreamingMessages, type StreamingTurn } from './merge-streaming-messages';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    session_id: 's1',
    turn_index: 1,
    role: 'assistant',
    revision: 0,
    content: '旧回复',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: 'model-1',
    created_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

const user = message({ id: 'u1', role: 'user', content: '你好', turn_index: 1 });
const assistant = message({ id: 'a1', role: 'assistant', content: '旧回复', turn_index: 1 });

function streaming(overrides: Partial<StreamingTurn> = {}): StreamingTurn {
  return {
    mode: 'send',
    userMessage: message({
      id: 'local:1',
      role: 'user',
      content: '新问题',
      turn_index: Number.MAX_SAFE_INTEGER,
    }),
    assistantMessageId: 'a2',
    turnIndex: 2,
    revision: 0,
    text: '正在写',
    ...overrides,
  };
}

describe('mergeStreamingMessages', () => {
  it('没有临时态时原样返回落库列表', () => {
    const persisted = [user, assistant];
    expect(mergeStreamingMessages(persisted, null, 's1')).toBe(persisted);
  });

  it('发送中把本地用户气泡和正在写的 assistant 叠在落库态后面', () => {
    const merged = mergeStreamingMessages([user, assistant], streaming(), 's1');
    expect(merged).toHaveLength(4);
    expect(merged[2]?.id).toBe('local:1');
    expect(merged[3]).toMatchObject({
      id: 'a2',
      session_id: 's1',
      turn_index: 2,
      role: 'assistant',
      content: '正在写',
      status: 'streaming',
    });
  });

  it('重生成时藏起落库的最后一条 assistant，避免并排两条', () => {
    const merged = mergeStreamingMessages(
      [user, assistant],
      streaming({ mode: 'regenerate', userMessage: null, assistantMessageId: 'a1b', text: '新稿' }),
      's1'
    );
    expect(merged.map((item) => item.id)).toEqual(['u1', 'a1b']);
    expect(merged.at(-1)).toMatchObject({ content: '新稿', status: 'streaming' });
  });

  it('start 还没到时只展示本地用户气泡，不造假 assistant', () => {
    const merged = mergeStreamingMessages(
      [user, assistant],
      streaming({ assistantMessageId: null, text: '' }),
      's1'
    );
    expect(merged).toHaveLength(3);
    expect(merged.at(-1)?.id).toBe('local:1');
  });
});
