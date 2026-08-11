import { describe, expect, it } from 'vitest';
import { buildEngineHistory } from './history.js';
import type { EngineHistoryMessage } from '../engine/index.js';

const OPENING = '（开场白）';

function ctx(...messages: Array<[EngineHistoryMessage['role'], string]>): EngineHistoryMessage[] {
  return messages.map(([role, content]) => ({ role, content }));
}

describe('buildEngineHistory', () => {
  it('把开场白放在历史轮次之前', () => {
    expect(buildEngineHistory(ctx(['user', '你好'], ['assistant', '嗨']), OPENING)).toEqual([
      { role: 'assistant', content: OPENING },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
    ]);
  });

  it('过滤空回复，不让失败或中断的空正文进入 prompt', () => {
    expect(
      buildEngineHistory(ctx(['user', '上一轮'], ['assistant', ''], ['user', '这一轮']), OPENING)
    ).toEqual([
      { role: 'assistant', content: OPENING },
      { role: 'user', content: '上一轮' },
      { role: 'user', content: '这一轮' },
    ]);
  });

  it('第一轮没有历史时只返回开场白', () => {
    expect(buildEngineHistory([], OPENING)).toEqual([{ role: 'assistant', content: OPENING }]);
  });

  it('空开场白和空上下文不产生消息', () => {
    expect(buildEngineHistory([], '')).toEqual([]);
  });
});
