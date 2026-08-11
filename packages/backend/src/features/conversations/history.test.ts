import { describe, expect, it } from 'vitest';
import { buildEngineHistory } from './history.js';
import type { ChatContextMessage } from '../../infrastructure/repositories/ChatMessageRepository.js';

const OPENING: ChatContextMessage = { role: 'assistant', content: '（开场白）' };

function ctx(...messages: Array<[ChatContextMessage['role'], string]>): ChatContextMessage[] {
  return messages.map(([role, content]) => ({ role, content }));
}

describe('buildEngineHistory', () => {
  it('切掉尾部本轮 user 消息，其余按原序保留', () => {
    const { history, tailMismatch } = buildEngineHistory(
      [OPENING, ...ctx(['user', '你好'], ['assistant', '嗨'], ['user', '然后呢？'])],
      '然后呢？'
    );

    expect(history).toEqual([
      OPENING,
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
    ]);
    expect(tailMismatch).toBe(false);
  });

  it('重生成路径：连同 RPC 新插入的空占位 assistant 行一起切掉', () => {
    const { history, tailMismatch } = buildEngineHistory(
      [OPENING, ...ctx(['user', '然后呢？'], ['assistant', ''])],
      '然后呢？'
    );

    expect(history).toEqual([OPENING]);
    expect(tailMismatch).toBe(false);
  });

  it('丢掉失败收口留下的空正文行，不让它进 prompt', () => {
    const { history } = buildEngineHistory(
      [OPENING, ...ctx(['user', '上一轮'], ['assistant', ''], ['user', '这一轮'])],
      '这一轮'
    );

    expect(history).toEqual([OPENING, { role: 'user', content: '上一轮' }]);
  });

  it('只有开场白的会话：第一轮的 history 就是那条开场白', () => {
    const { history, tailMismatch } = buildEngineHistory(
      [OPENING, ...ctx(['user', '你好'])],
      '你好'
    );

    expect(history).toEqual([OPENING]);
    expect(tailMismatch).toBe(false);
  });

  it('开场白只出现一次（回归「引擎重复注入 first_mes」那个坑）', () => {
    const { history } = buildEngineHistory([OPENING, ...ctx(['user', '你好'])], '你好');
    expect(history.filter((message) => message.content === OPENING.content)).toHaveLength(1);
  });

  it('尾部 user 与本轮输入对不上时标记 tailMismatch，但仍按位置切', () => {
    const { history, tailMismatch } = buildEngineHistory(
      ctx(['user', '别人插进来的一条']),
      '我发的'
    );

    expect(history).toEqual([]);
    expect(tailMismatch).toBe(true);
  });

  it('尾部不是 user 消息时不乱切，交给调用方打点', () => {
    const { history, tailMismatch } = buildEngineHistory([OPENING], '你好');

    expect(history).toEqual([OPENING]);
    expect(tailMismatch).toBe(true);
  });

  it('空上下文不炸', () => {
    expect(buildEngineHistory([], '你好')).toEqual({ history: [], tailMismatch: true });
  });
});
