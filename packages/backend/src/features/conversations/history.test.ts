import { describe, expect, it } from 'vitest';
import {
  buildEngineHistory,
  INTERRUPTED_REPLY_BODY_MAX_CHARS,
  turnsToPromptMessages,
} from './history.js';
import type { StoryTurn } from '../story-memory/text.js';
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

const TAIL =
  '\n\n[choices]\n[choice]A[/choice]\n[/choices]\n[status]\n<details><summary>状态</summary></details>\n[/status]\n[memory]\n<details><summary>工作记忆</summary></details>\n[/memory]';

function turn(turnIndex: number, reply: string | null, status = 'success'): StoryTurn {
  return { turnIndex, userInput: `问${turnIndex}`, assistantReply: reply, status };
}

describe('turnsToPromptMessages', () => {
  it('旧轮次只留正文，最近一条正常回复保留完整尾部', () => {
    const messages = turnsToPromptMessages([
      turn(1, `正文1${TAIL}`),
      turn(2, `正文2${TAIL}`),
      turn(3, `正文3${TAIL}`),
    ]);
    const replies = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(replies).toEqual(['正文1', '正文2', `正文3${TAIL}`]);
  });

  it('没有尾部的回复原样保留，不改动字节', () => {
    const reply = '  带前导空白的正文\n\n第二段 ';
    const messages = turnsToPromptMessages([turn(1, reply), turn(2, '后一轮')]);
    expect(messages[1]).toEqual({ role: 'assistant', content: reply });
  });

  it('中断回复不带尾部，且正文超过上限时截断', () => {
    const runaway = '循环'.repeat(INTERRUPTED_REPLY_BODY_MAX_CHARS) + TAIL;
    const messages = turnsToPromptMessages([
      turn(1, `正文1${TAIL}`),
      turn(2, runaway, 'stream_interrupted'),
    ]);
    const replies = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    // 最后一轮是中断回复，完整尾部留给最近一条正常回复（第 1 轮）。
    expect(replies[0]).toBe(`正文1${TAIL}`);
    expect(replies[1]).toHaveLength(INTERRUPTED_REPLY_BODY_MAX_CHARS);
    expect(replies[1]).not.toContain('[memory]');
  });

  it('只有尾部的旧回复整条不入模，空回复也不入模', () => {
    const messages = turnsToPromptMessages([
      turn(1, TAIL.trim(), 'stream_interrupted'),
      turn(2, null),
      turn(3, `正文3${TAIL}`),
    ]);
    expect(messages.filter((m) => m.role === 'assistant')).toEqual([
      { role: 'assistant', content: `正文3${TAIL}` },
    ]);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(3);
  });

  it('没有 status（压缩读取等）按正常回复处理', () => {
    const messages = turnsToPromptMessages([
      { turnIndex: 1, userInput: '问', assistantReply: `正文${TAIL}` },
    ]);
    expect(messages[1]!.content).toBe(`正文${TAIL}`);
  });
});
