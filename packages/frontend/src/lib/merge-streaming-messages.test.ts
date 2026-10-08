import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';

import {
  appendStreamText,
  applyStreamStart,
  mergeStreamingMessages,
  type StreamingTurn,
} from './merge-streaming-messages';

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
    requestId: 'request-A',
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
    postprocessVersion: null,
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
      streaming({
        mode: 'regenerate',
        revision: 1,
        userMessage: null,
        assistantMessageId: 'a1b',
        text: '新稿',
      }),
      's1'
    );
    expect(merged.map((item) => item.id)).toEqual(['u1', 'a1b']);
    expect(merged.at(-1)).toMatchObject({ content: '新稿', status: 'streaming' });
  });

  it('把 start 里的 postprocess_version 写到正在生成的 assistant 上', () => {
    const turn = applyStreamStart(streaming({ assistantMessageId: null, text: '' }), {
      type: 'start',
      turn_index: 4,
      user_message_id: 'u4',
      assistant_message_id: 'a4',
      revision: 0,
      postprocess_version: 7,
    });
    const merged = mergeStreamingMessages([user, assistant], turn, 's1');
    expect(merged.at(-1)).toMatchObject({
      id: 'a4',
      content: '',
      postprocess_version: 7,
      status: 'streaming',
    });
  });

  it('缺失版本按 null 保留，增量不会改成别的版本', () => {
    const started = applyStreamStart(streaming({ text: '原' }), {
      type: 'start',
      turn_index: 2,
      user_message_id: 'u2',
      assistant_message_id: 'a2',
      revision: 1,
    });
    const appended = appendStreamText(started, '文');
    expect(appended.postprocessVersion).toBeNull();
    expect(appended.text).toBe('原文');
    const merged = mergeStreamingMessages([user], appended, 's1');
    expect(merged.at(-1)?.postprocess_version).toBeNull();
    expect(merged.at(-1)?.content).toBe('原文');
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

it('详情轮询先拿到当前消息时不重复用户和 assistant 气泡', () => {
  const currentUser = message({ id: 'u2', role: 'user', turn_index: 2 });
  const currentAssistant = message({ id: 'a2', turn_index: 2, status: 'streaming' });
  const result = mergeStreamingMessages(
    [user, assistant, currentUser, currentAssistant],
    streaming({ userMessage: currentUser }),
    's1'
  );
  expect(result.map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  expect(result.at(-1)?.content).toBe('正在写');
});

it('服务端已确认取消/完成时本地占位不能覆盖终态', () => {
  const terminal = message({
    id: 'a2',
    turn_index: 2,
    status: 'interrupted',
    finish_reason: 'cancelled',
    content: '保留正文',
  });
  const persisted = [user, assistant, terminal];
  expect(mergeStreamingMessages(persisted, streaming(), 's1')).toBe(persisted);
});

it('start 被缓冲但详情已拿到预期轮次时只展示一组真实消息', () => {
  const currentUser = message({ id: 'a2:user', role: 'user', turn_index: 2, revision: 0 });
  const currentAssistant = message({
    id: 'a2',
    turn_index: 2,
    revision: 0,
    status: 'streaming',
    content: '已落库部分',
    request_id: 'request-A',
  });
  const result = mergeStreamingMessages(
    [user, assistant, currentUser, currentAssistant],
    streaming({ assistantMessageId: null, text: '' }),
    's1'
  );
  expect(result.map((item) => item.id)).toEqual(['u1', 'a1', 'a2:user', 'a2']);
  expect(result.at(-1)?.content).toBe('已落库部分');
});

it('start 前不能把其他设备同轮次/版本的回复与用户气泡当作自己的', () => {
  const otherUser = message({ id: 'B:user', role: 'user', turn_index: 2, content: 'other input' });
  const otherAssistant = message({
    id: 'B',
    turn_index: 2,
    status: 'streaming',
    request_id: 'request-B',
    content: 'other output',
  });
  const result = mergeStreamingMessages(
    [user, assistant, otherUser, otherAssistant],
    streaming({ assistantMessageId: null, text: '' }),
    's1'
  );
  expect(result.map((item) => item.id)).toEqual(['u1', 'a1', 'B:user', 'B', 'local:1']);
  expect(result.at(-1)?.content).toBe('新问题');
  expect(result.find((item) => item.id === 'B')?.content).toBe('other output');
});

it('重生成等待 start 时不会隐藏另一设备新接受的同版本回复', () => {
  const otherAssistant = message({
    id: 'B',
    turn_index: 1,
    revision: 1,
    status: 'streaming',
    request_id: 'request-B',
  });
  const result = mergeStreamingMessages(
    [user, otherAssistant],
    streaming({
      mode: 'regenerate',
      turnIndex: 1,
      revision: 1,
      assistantMessageId: null,
      userMessage: null,
    }),
    's1'
  );
  expect(result.map((item) => item.id)).toEqual(['u1', 'B']);
});
