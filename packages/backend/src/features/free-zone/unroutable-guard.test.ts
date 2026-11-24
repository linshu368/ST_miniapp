import { describe, expect, it, vi } from 'vitest';
import { delistUnroutable, initialState, type FreeZoneModelState } from './lifecycle.js';
import {
  createUnroutableGuard,
  REFUSAL_MIN_SPAN_MS,
  REFUSAL_MIN_STREAK,
  type PrimaryCallOutcome,
} from './unroutable-guard.js';

function harness(delisted = true) {
  let now = Date.parse('2026-11-24T10:00:00Z');
  const delist = vi.fn(async () => delisted);
  const info = vi.fn();
  const note = createUnroutableGuard({ delist, now: () => now, log: { info, warn: vi.fn() } });
  const call = (httpStatus: number | null, providers = ['google']): PrimaryCallOutcome => ({
    candidateId: 'free-gemini-3-flash-preview',
    providers,
    httpStatus,
  });
  return { note, call, delist, info, tick: (ms: number) => (now += ms) };
}

/** 连续拒单 times 次，首尾相隔 spanMs */
function refuse(h: ReturnType<typeof harness>, times: number, spanMs: number, status = 404): void {
  for (let i = 0; i < times; i += 1) {
    if (i > 0) h.tick(spanMs / (times - 1));
    h.note(h.call(status));
  }
}

describe('createUnroutableGuard', () => {
  it('delists once after enough consecutive refusals over enough time', async () => {
    const h = harness();
    refuse(h, REFUSAL_MIN_STREAK, REFUSAL_MIN_SPAN_MS);
    // 正在下架时后续调用不重复触发
    h.note(h.call(503));
    await vi.waitFor(() => expect(h.info).toHaveBeenCalled());
    expect(h.delist).toHaveBeenCalledTimes(1);
    expect(h.delist).toHaveBeenCalledWith({
      candidateId: 'free-gemini-3-flash-preview',
      providers: ['google'],
      reasons: ['连续 10 次被拒单（10 分钟，报价跌破底线或没有卖家）'],
    });
  });

  it('does not delist on a short supply gap, however many refusals it has', () => {
    const h = harness();
    refuse(h, REFUSAL_MIN_STREAK * 5, REFUSAL_MIN_SPAN_MS - 1);
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('does not delist on a few refusals spread over a long time', () => {
    const h = harness();
    refuse(h, REFUSAL_MIN_STREAK - 1, REFUSAL_MIN_SPAN_MS * 10);
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('starts over when a call goes through', () => {
    const h = harness();
    refuse(h, REFUSAL_MIN_STREAK - 1, REFUSAL_MIN_SPAN_MS);
    h.note(h.call(200));
    refuse(h, REFUSAL_MIN_STREAK - 1, REFUSAL_MIN_SPAN_MS);
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('neither counts nor resets on calls stopped before headers and on other errors', async () => {
    const h = harness();
    refuse(h, REFUSAL_MIN_STREAK - 1, REFUSAL_MIN_SPAN_MS);
    h.note(h.call(null));
    h.note(h.call(429));
    h.note(h.call(500));
    expect(h.delist).not.toHaveBeenCalled();
    h.note(h.call(404));
    await vi.waitFor(() => expect(h.info).toHaveBeenCalled());
    expect(h.delist).toHaveBeenCalledTimes(1);
  });

  it('starts over when the provider changes', () => {
    const h = harness();
    refuse(h, REFUSAL_MIN_STREAK - 1, REFUSAL_MIN_SPAN_MS);
    h.note(h.call(404, ['venice']));
    expect(h.delist).not.toHaveBeenCalled();
  });

  it('counts afresh after a delist attempt', async () => {
    const h = harness(false);
    refuse(h, REFUSAL_MIN_STREAK, REFUSAL_MIN_SPAN_MS);
    await vi.waitFor(() => expect(h.info).toHaveBeenCalled());
    h.note(h.call(404));
    expect(h.delist).toHaveBeenCalledTimes(1);
  });
});

describe('delistUnroutable', () => {
  it('takes the model off as a price delist with no automatic return', () => {
    const listed: FreeZoneModelState = {
      ...initialState('free-gemini-3-flash-preview'),
      status: 'listed',
      providers: ['google'],
      providerSince: '2026-11-24T09:23:27.555Z',
    };
    const { state, event } = delistUnroutable({ state: listed, reasons: ['连续 10 次被拒单'] });
    expect(state).toEqual({
      candidateId: 'free-gemini-3-flash-preview',
      status: 'unlisted',
      providers: [],
      providerSince: null,
      lastReason: '连续 10 次被拒单',
    });
    expect(event).toEqual({ type: 'delisted', cause: 'official', reasons: ['连续 10 次被拒单'] });
  });
});
