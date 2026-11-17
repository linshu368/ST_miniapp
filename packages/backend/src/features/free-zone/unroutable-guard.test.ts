import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG } from '@miniapp/shared';
import { delistUnroutable, initialState, type FreeZoneModelState } from './lifecycle.js';
import {
  createUnroutableGuard,
  judgeUnroutable,
  UNROUTABLE_MAX_AGE_MS,
  type PrimaryCallOutcome,
} from './unroutable-guard.js';

const T0 = Date.parse('2026-11-16T10:00:00Z');

describe('judgeUnroutable', () => {
  const samples = (pattern: string, at = T0) =>
    [...pattern].map((char) => ({ at, unroutable: char === 'x' }));

  it('waits for enough calls, then trips above the limit', () => {
    expect(judgeUnroutable(samples('xxxxxxxxx'), T0, 50).trip).toBe(false);
    expect(judgeUnroutable(samples('xxxxxx....'), T0, 50)).toEqual({
      calls: 10,
      unroutable: 6,
      trip: true,
    });
    // 正好等于上限不算超过
    expect(judgeUnroutable(samples('xxxxx.....'), T0, 50).trip).toBe(false);
  });

  it('never trips when the limit is off', () => {
    expect(judgeUnroutable(samples('xxxxxxxxxxxxxxxxxxxx'), T0, null).trip).toBe(false);
  });

  it('only looks at the last 20 calls within the last hour', () => {
    const old = samples('xxxxxxxxxx', T0 - UNROUTABLE_MAX_AGE_MS - 1);
    expect(judgeUnroutable([...old, ...samples('.....')], T0, 50).trip).toBe(false);
    const healthyLately = [...samples('xxxxxxxxxx'), ...samples('....................')];
    expect(judgeUnroutable(healthyLately, T0, 50)).toMatchObject({ calls: 20, unroutable: 0 });
  });
});

function harness(delisted = true) {
  let now = T0;
  const delist = vi.fn(async () => delisted);
  const info = vi.fn();
  const note = createUnroutableGuard({
    delist,
    now: () => now,
    log: { info, warn: vi.fn() },
  });
  const call = (httpStatus: number | null, providers = ['openrouter']): PrimaryCallOutcome => ({
    candidateId: 'free-deepseek-v4-1-flash',
    providers,
    httpStatus,
    maxUnroutablePct: 50,
  });
  return {
    note,
    call,
    delist,
    info,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('createUnroutableGuard', () => {
  it('delists once when most real calls are refused', async () => {
    const h = harness();
    for (let i = 0; i < 9; i += 1) h.note(h.call(i < 2 ? 200 : 404));
    expect(h.delist).not.toHaveBeenCalled();
    h.note(h.call(503));
    // 正在下架时后续调用不重复触发
    h.note(h.call(404));
    await vi.waitFor(() => expect(h.info).toHaveBeenCalled());
    expect(h.delist).toHaveBeenCalledTimes(1);
    expect(h.delist).toHaveBeenCalledWith({
      candidateId: 'free-deepseek-v4-1-flash',
      providers: ['openrouter'],
      reasons: ['真实请求派不出去 8/10 > 50%'],
    });
  });

  it('ignores calls stopped before headers', () => {
    const h = harness();
    // 响应头前就被取消的（并发落败、兜底抢先）不算样本：这里只有 6 次正常 + 6 次拒单
    for (let i = 0; i < 30; i += 1) h.note(h.call(i % 5 === 0 ? 200 : i % 5 === 1 ? 404 : null));
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('keeps a model whose refusals stay under the limit', () => {
    const h = harness();
    for (let i = 0; i < 60; i += 1) h.note(h.call(i % 3 === 0 ? 404 : 200));
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('starts over when the provider changes', () => {
    const h = harness();
    for (let i = 0; i < 9; i += 1) h.note(h.call(404, ['openrouter']));
    h.note(h.call(404, ['deepseek']));
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('counts afresh after a delist attempt', async () => {
    const h = harness(false);
    for (let i = 0; i < 10; i += 1) h.note(h.call(404));
    await vi.waitFor(() => expect(h.info).toHaveBeenCalled());
    h.note(h.call(404));
    expect(h.delist).toHaveBeenCalledTimes(1);
  });
});

describe('delistUnroutable', () => {
  it('takes the model off with the official cooldown', () => {
    const listed: FreeZoneModelState = {
      ...initialState('free-deepseek-v4-1-flash'),
      status: 'listed',
      providers: ['openrouter'],
      providerSince: '2026-11-16T09:23:27.555Z',
    };
    const now = new Date(T0);
    const { state, event } = delistUnroutable({
      state: listed,
      now,
      relist: DEFAULT_FREE_ZONE_CONFIG.relist,
      reasons: ['真实请求派不出去 8/10 > 50%'],
    });
    const cooldownUntil = new Date(
      T0 + DEFAULT_FREE_ZONE_CONFIG.relist.price_cooldown_minutes * 60_000
    ).toISOString();
    expect(state).toMatchObject({ status: 'cooling', providers: [], cooldownUntil });
    expect(event).toEqual({
      type: 'delisted',
      cause: 'official',
      reasons: ['真实请求派不出去 8/10 > 50%'],
      cooldownUntil,
    });
  });
});
