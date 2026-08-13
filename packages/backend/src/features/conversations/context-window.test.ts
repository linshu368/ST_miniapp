import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONTEXT_TURNS,
  DEFAULT_RETAIN_CONTEXT_TURNS,
  nextContextWindowStartTurn,
  resolveContextWindowLimits,
} from './context-window.js';

describe('resolveContextWindowLimits', () => {
  it('缺省用代码默认值 A=50 B=75', () => {
    expect(resolveContextWindowLimits(null, null)).toEqual({
      maxTurns: DEFAULT_MAX_CONTEXT_TURNS,
      retainTurns: DEFAULT_RETAIN_CONTEXT_TURNS,
    });
  });

  it('非法值回落默认，并保证 A ≤ B', () => {
    expect(resolveContextWindowLimits(0, -1)).toEqual({
      maxTurns: DEFAULT_MAX_CONTEXT_TURNS,
      retainTurns: DEFAULT_RETAIN_CONTEXT_TURNS,
    });
    expect(resolveContextWindowLimits(10, 50)).toEqual({ maxTurns: 10, retainTurns: 10 });
    expect(resolveContextWindowLimits('40', '20')).toEqual({ maxTurns: 40, retainTurns: 20 });
    expect(resolveContextWindowLimits(3.5, 2)).toEqual({
      maxTurns: DEFAULT_MAX_CONTEXT_TURNS,
      retainTurns: 2,
    });
  });

  it('A=B 合法，退化为滑动窗口', () => {
    expect(resolveContextWindowLimits(75, 75)).toEqual({ maxTurns: 75, retainTurns: 75 });
  });
});

describe('nextContextWindowStartTurn', () => {
  const window = { maxTurns: 75, retainTurns: 50 };

  it('未超 B 时起点不动，前缀只增长', () => {
    expect(nextContextWindowStartTurn({ currentStart: 1, completedTurns: 0, ...window })).toBe(1);
    expect(nextContextWindowStartTurn({ currentStart: 1, completedTurns: 75, ...window })).toBe(1);
  });

  it('第 77 轮（completed=76）泄洪到最近 50 轮', () => {
    expect(nextContextWindowStartTurn({ currentStart: 1, completedTurns: 76, ...window })).toBe(27);
  });

  it('泄洪后在 [A, B] 增长段不再改写起点', () => {
    expect(nextContextWindowStartTurn({ currentStart: 27, completedTurns: 101, ...window })).toBe(
      27
    );
  });

  it('再次超过 B 时跳到新的 A', () => {
    expect(nextContextWindowStartTurn({ currentStart: 27, completedTurns: 102, ...window })).toBe(
      53
    );
  });

  it('A=B 时每轮丢掉最老一轮', () => {
    const sliding = { maxTurns: 3, retainTurns: 3 };
    expect(nextContextWindowStartTurn({ currentStart: 1, completedTurns: 3, ...sliding })).toBe(1);
    expect(nextContextWindowStartTurn({ currentStart: 1, completedTurns: 4, ...sliding })).toBe(2);
    expect(nextContextWindowStartTurn({ currentStart: 2, completedTurns: 5, ...sliding })).toBe(3);
  });
});
